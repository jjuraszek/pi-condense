import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ChainCompressionEntry,
  DedupAliasEntryData,
  IndexEntryData,
  ToolCallRecord,
} from "./types.js";
import {
  CUSTOM_TYPE_CHAIN,
  CUSTOM_TYPE_DEDUP_ALIAS,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_SUMMARY,
} from "./types.js";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  type SummaryToolCallRef,
} from "./summary-refs.js";
import { hashToolResult } from "./content-hash.js";
import { bareToolCallId, occKey, parseOccKey } from "./occurrence-key.js";
import { mkdir, writeFile } from "node:fs/promises";
import { applySpill, blobDirFor, blobPathFor } from "./spill.js";

export class ToolCallIndexer {
  /** occurrence key (`id@resultTimestamp`, or bare id for legacy) -> record */
  private index = new Map<string, ToolCallRecord>();
  /** bare toolCallId -> its occurrence keys, in insertion order */
  private bareIdToKeys = new Map<string, string[]>();
  private aliasToToolCallId = new Map<string, string>();
  private toolCallIdToAlias = new Map<string, string>();
  private nextShortAliasNumber = 1;
  /**
   * hash -> original occurrence key (or legacy bare id). Populated as
   * records enter the indexer (`addBatch`) and on `reconstructFromSession`.
   * Drives the pre-flush dedup pass via `lookupByContent`.
   */
  private contentHashToOriginal = new Map<string, string>();
  /**
   * Duplicate occurrence key (or legacy bare id) -> original occurrence key
   * (or legacy bare id). Populated by `registerDuplicate` during the
   * pre-flush dedup pass and rebuilt from CUSTOM_TYPE_DEDUP_ALIAS entries on
   * reconstruction.
   *
   * Both `isSummarized` and `resolveToolCallId` consult this map so
   * `pruneMessages` stub-replaces dup toolResults and `context_tree_query`
   * resolves dup ids to the original record.
   */
  private dedupAliasToOriginal = new Map<string, string>();
  /**
   * Per-batch summary bodies for chain-compression summary text lookup.
   * Each entry maps a set of toolCallIds to the summary's markdown body.
   * Populated from CUSTOM_TYPE_SUMMARY entries at rebuild time and via
   * `registerSummaryBody` after a successful flush.
   */
  private summaryBodies: Array<{ toolCallIds: string[]; text: string }> = [];
  /** Compressed chains, keyed on startUserTimestamp for O(1) dedup checks. */
  private chainRegistry = new Map<number, ChainCompressionEntry>();

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.bareIdToKeys.clear();
    this.aliasToToolCallId.clear();
    this.toolCallIdToAlias.clear();
    this.contentHashToOriginal.clear();
    this.dedupAliasToOriginal.clear();
    this.nextShortAliasNumber = 1;
    this.summaryBodies = [];
    this.chainRegistry.clear();

    // Two passes so dedup aliases land AFTER the original short refs they
    // need to reuse, regardless of the underlying append order.
    const branch = ctx.sessionManager.getBranch();
    const dedupAliasEntries: DedupAliasEntryData[] = [];

    for (const entry of branch) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        const backfilled = data.backfilled === true;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            const key = this.indexRecord(toolCall);
            // First-seen wins so the contentHashToOriginal map matches what
            // addBatch would have produced at append time. Backfilled records
            // never seed this map (dedup poison guard - see backfillChainRecords).
            if (!backfilled) {
              const hash = toolCall.contentHash ?? hashToolResult(toolCall.toolName, toolCall.resultText);
              if (!this.contentHashToOriginal.has(hash)) {
                this.contentHashToOriginal.set(hash, key);
              }
            }
          }
        }
        if (backfilled && Array.isArray(data.refs)) this.registerSummaryRefs(data.refs);
        continue;
      }

      if (entry.type === "custom_message" && (entry as any).customType === CUSTOM_TYPE_SUMMARY) {
        const refs = normalizeSummaryToolCallRefs((entry as any).details);
        this.registerSummaryRefs(refs);
        const raw = (entry as any).content;
        const text =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text as string)
                  .join("\n")
              : "";
        if (text) {
          this.summaryBodies.push({ toolCallIds: refs.map((r) => occKey(r.toolCallId, r.resultTimestamp)), text });
        }
        continue;
      }

      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_CHAIN) {
        const data = (entry as any).data as ChainCompressionEntry;
        if (data?.blockId && typeof data.startUserTimestamp === "number") {
          this.chainRegistry.set(data.startUserTimestamp, data);
        }
        continue;
      }

      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_DEDUP_ALIAS) {
        const data = (entry as any).data as DedupAliasEntryData;
        if (data?.newToolCallId && data?.originalToolCallId) {
          dedupAliasEntries.push(data);
        }
      }
    }

    for (const data of dedupAliasEntries) {
      const newKey = occKey(data.newToolCallId, data.newResultTimestamp);
      const originalKey = occKey(data.originalToolCallId, data.originalResultTimestamp);
      this.dedupAliasToOriginal.set(newKey, originalKey);
      const originalShortRef = this.toolCallIdToAlias.get(originalKey);
      if (originalShortRef) {
        // Keep `getShortRefForToolCallId(dupId)` returning the SAME short ref
        // as the original so pruneMessages emits a consistent `tN` for both.
        this.toolCallIdToAlias.set(newKey, originalShortRef);
      }
    }
  }

  /**
   * Indexes a single record under its occurrence key and updates the
   * bare-id reverse index + legacy-shape tracking. Shared by `addBatch` and
   * `reconstructFromSession` so both paths key identically.
   */
  private indexRecord(record: ToolCallRecord): string {
    const key = occKey(record.toolCallId, record.resultTimestamp);
    this.index.set(key, record);
    const keys = this.bareIdToKeys.get(record.toolCallId) ?? [];
    if (!keys.includes(key)) keys.push(key);
    this.bareIdToKeys.set(record.toolCallId, keys);
    return key;
  }

  /**
   * Returns true if the given occurrence key has been pruned - either
   * because its full record is in the index, or because it has been
   * registered as an alias of an already-indexed original via the
   * content-hash dedup pass.
   *
   * STRICT lookup: no bare-id uniquification happens here, unlike
   * `resolveToolCallId`/`getRecord`/`getRecordsForId`. A bare-id fallback
   * in this method would be a silent correctness bug - it would report an
   * unrelated LIVE tool result as summarized merely because an older
   * occurrence of the same provider-reused id was summarized. Callers that
   * need bare-id resolution use `resolveToolCallId` (unambiguous case) or
   * `getRecordsForId` (all occurrences).
   *
   * `pruneMessages` uses this to decide whether to stub-replace a
   * ToolResultMessage; both index and dedup-alias hits need the same
   * treatment.
   */
  isSummarized(occurrenceKey: string): boolean {
    return this.index.has(occurrenceKey) || this.dedupAliasToOriginal.has(occurrenceKey);
  }

  /**
   * Returns the full runtime index map.
   */
  getIndex(): Map<string, ToolCallRecord> {
    return this.index;
  }

  /**
   * Register short aliases for a summary message so future recovery queries can
   * resolve the short ids back to the persisted toolCallIds.
   */
  registerSummaryRefs(refs: SummaryToolCallRef[]): void {
    for (const ref of refs) {
      if (!ref.shortId || !ref.toolCallId) continue;
      const key = occKey(ref.toolCallId, ref.resultTimestamp);
      if (ref.shortId !== key) {
        this.aliasToToolCallId.set(ref.shortId, key);
        this.toolCallIdToAlias.set(key, ref.shortId);
      }
      const match = /^t(\d+)$/.exec(ref.shortId);
      if (match) {
        this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
      }
    }
  }

  /**
   * Allocates short aliases for a batch's tool calls and registers them in the
   * runtime alias map.
   */
  allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[] {
    const calls = batch.toolCalls.map((tc) => ({ toolCallId: tc.toolCallId, resultTimestamp: tc.resultTimestamp }));
    const { refs, nextIndex } = buildShortToolCallRefs(calls, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  /**
   * Resolve a short alias, a duplicate's occurrence key, or a full occurrence
   * key (or legacy bare id) to the canonical occurrence key backing it.
   *
   * Order:
   *   1. Direct hit in `this.index` (canonical occurrence key).
   *   2. Dedup alias → underlying original occurrence key.
   *   3. Short-ref (`t3`) → underlying occurrence key.
   *   4. Bare id with exactly ONE occurrence → that occurrence's key.
   *
   * A bare id with several occurrences resolves to undefined here — that
   * ambiguity is fail-closed by design; callers that must handle collisions
   * use `getRecordsForId`.
   *
   * Used by `getRecord`/`lookupToolCalls` so `context_tree_query` returns
   * the original record for both short refs and dedup'd ids.
   */
  resolveToolCallId(input: string): string | undefined {
    if (this.index.has(input)) return input;
    const dedupTarget = this.dedupAliasToOriginal.get(input);
    if (dedupTarget) return dedupTarget;
    const aliased = this.aliasToToolCallId.get(input);
    if (aliased) return aliased;
    const keys = this.bareIdToKeys.get(input);
    if (keys && keys.length === 1) return keys[0];
    return undefined;
  }

  /**
   * Returns the short alias (e.g. "t1") registered for the given occurrence
   * key (or legacy bare id), or undefined if none was registered. Legacy
   * summaries written before short-refs were introduced map shortId === key
   * and intentionally return undefined here so callers (e.g. the pruner
   * stub) can fall back to the key itself.
   */
  getShortRefForToolCallId(occurrenceKey: string): string | undefined {
    return this.toolCallIdToAlias.get(occurrenceKey);
  }

  /**
   * Look up a single record by occurrence key, short alias, or (unambiguous)
   * bare id (used by query tool).
   */
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (!resolved) return undefined;
    return this.index.get(resolved);
  }

  /**
   * Looks up multiple tool call records by occurrence key / short alias.
   * Skips any not found.
   */
  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.getRecord(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Every record a bare toolCallId, occurrence key, or short ref can denote,
   * sorted by `resultTimestamp ?? timestamp` ascending. A bare id with
   * multiple occurrences returns all of them; an occurrence key/short ref
   * returns exactly the one record it resolves to.
   *
   * The sort is display order for a multi-match listing, not a causal
   * clock: it mixes a tool-result timestamp with a batch-capture timestamp,
   * which are both epoch ms from the same session and adequate for a
   * listing but not a strict ordering guarantee.
   */
  getRecordsForId(input: string): ToolCallRecord[] {
    const keys = this.bareIdToKeys.get(input);
    const records = (keys ?? [])
      .map((k) => this.index.get(k))
      .filter((r): r is ToolCallRecord => r !== undefined);

    // Dedup-alias occurrences aren't tracked in `bareIdToKeys` (it only
    // covers indexed records), so a bare id whose collision was content-
    // deduplicated would otherwise be silently omitted here. Resolve each
    // matching alias to the record it aliases, but label it with the
    // ALIAS's own occurrence timestamp (not the original's) so a reader can
    // tell the two occurrences apart.
    for (const [aliasKey, originalKey] of this.dedupAliasToOriginal) {
      if (bareToolCallId(aliasKey) !== input) continue;
      const original = this.index.get(originalKey);
      if (!original) continue;
      const { resultTimestamp } = parseOccKey(aliasKey);
      records.push({ ...original, resultTimestamp });
    }

    if (records.length > 0) {
      return records.sort((a, b) => (a.resultTimestamp ?? a.timestamp) - (b.resultTimestamp ?? b.timestamp));
    }
    const record = this.getRecord(input);
    return record ? [record] : [];
  }

  /**
   * True when the bare id is LEGACY-ONLY: a record is indexed under the
   * bare key AND that bare id has no occurrence-keyed siblings. A legacy
   * record has no `resultTimestamp`, so `occKey` keys it under its bare id
   * - meaning it already lives in `index` under that exact string; this is
   * a derivation, not a separate container.
   *
   * A session that spans the upgrade can hold BOTH a legacy bare record
   * and modern occurrence records under the same bare id (e.g. legacy
   * `bash_23` plus `bash_23@2150`). In that mixed case this must return
   * false: a live, unrelated `bash_23@9150` result is not the legacy one,
   * and a permissive true here would stub it with the stale legacy content
   * - the exact collision this bare-id path exists to avoid re-introducing.
   * `bareIdToKeys` already tracks every key minted under a bare id, so a
   * single-key entry is the discriminant. The pruner's only sanctioned
   * bare-id path.
   */
  hasLegacyBareRecord(toolCallId: string): boolean {
    if (!this.index.has(toolCallId)) return false;
    const keys = this.bareIdToKeys.get(toolCallId);
    return keys !== undefined && keys.length === 1;
  }

  /**
   * Returns the toolCallId of an already-indexed record whose
   * `(toolName, normalize(resultText))` matches the supplied input, or
   * `undefined` if there is no match. Driven by the in-memory
   * `contentHashToOriginal` map; only consults records that entered the
   * indexer via `addBatch` (i.e. previous successful prunes) or were
   * replayed at reconstruction time.
   *
   * Returns `undefined` for hash misses; consumers should treat that as
   * "not a duplicate".
   */
  lookupByContent(toolName: string, resultText: string): string | undefined {
    const hash = hashToolResult(toolName, resultText);
    return this.contentHashToOriginal.get(hash);
  }

  /**
   * Registers `newKey` as a duplicate of `originalKey` (each an occurrence
   * key, or a legacy bare id). The new id reuses the original's short alias
   * (so `pruneMessages` emits the same `tN` ref for both) and is persisted
   * via the supplied `appendEntry` so reconstruction can replay it later.
   *
   * No-op when `newKey === originalKey` (defensive).
   */
  registerDuplicate(
    newKey: string,
    originalKey: string,
    appendEntry: (customType: string, data?: unknown) => void,
  ): void {
    if (newKey === originalKey) return;
    this.dedupAliasToOriginal.set(newKey, originalKey);
    const originalShortRef = this.toolCallIdToAlias.get(originalKey);
    if (originalShortRef) {
      this.toolCallIdToAlias.set(newKey, originalShortRef);
    }
    const { toolCallId: newToolCallId, resultTimestamp: newResultTimestamp } = parseOccKey(newKey);
    const { toolCallId: originalToolCallId, resultTimestamp: originalResultTimestamp } = parseOccKey(originalKey);
    const payload: DedupAliasEntryData = {
      newToolCallId,
      originalToolCallId,
      ...(newResultTimestamp !== undefined ? { newResultTimestamp } : {}),
      ...(originalResultTimestamp !== undefined ? { originalResultTimestamp } : {}),
    };
    appendEntry(CUSTOM_TYPE_DEDUP_ALIAS, payload);
  }

  /**
   * Stores summary body text keyed by the toolCallIds it covers.
   * Called after a successful flush so `getPerBatchSummaryTextForToolCallIds`
   * can serve chain summaries without re-scanning session entries.
   */
  registerSummaryBody(toolCallIds: string[], text: string): void {
    if (text && toolCallIds.length > 0) {
      this.summaryBodies.push({ toolCallIds, text });
    }
  }

  /** Returns true if at least one stored summary covers any of the given toolCallIds. */
  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean {
    if (toolCallIds.length === 0) return false;
    const idSet = new Set(toolCallIds);
    return this.summaryBodies.some((s) => s.toolCallIds.some((id) => idSet.has(id)));
  }

  /**
   * Returns the distinct per-batch summary texts whose toolCallIds overlap the
   * given set (dedup'd by text). Used to build the synthetic chain body and as
   * the fusion input for the range summarizer; the >= 2 count gates fusion.
   */
  getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[] {
    if (toolCallIds.length === 0) return [];
    const idSet = new Set(toolCallIds);
    const texts: string[] = [];
    const seen = new Set<string>();
    for (const s of this.summaryBodies) {
      if (s.toolCallIds.some((id) => idSet.has(id)) && !seen.has(s.text)) {
        seen.add(s.text);
        texts.push(s.text);
      }
    }
    return texts;
  }

  /**
   * Returns the concatenated summary text for all per-batch summaries whose
   * toolCallIds overlap the given set, joined with "\n\n".
   * Used by chain-range-prune to build the synthetic chain message body.
   */
  getPerBatchSummaryTextForToolCallIds(toolCallIds: string[]): string {
    return this.getPerBatchSummariesForToolCallIds(toolCallIds).join("\n\n");
  }

  /**
   * Returns the short t<N> refs for the given toolCallIds.
   * Skips ids with no registered short ref (tool calls not yet summarized).
   */
  getToolRefsForToolCallIds(toolCallIds: string[]): string[] {
    const refs: string[] = [];
    for (const id of toolCallIds) {
      const ref = this.toolCallIdToAlias.get(id);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  /** Registers a chain entry in the in-memory registry. Called by chain-compressor after persisting. */
  registerChain(entry: ChainCompressionEntry): void {
    this.chainRegistry.set(entry.startUserTimestamp, entry);
  }

  /** Returns all compressed chain entries sorted by startUserTimestamp ascending. */
  getChainEntries(): ChainCompressionEntry[] {
    return [...this.chainRegistry.values()].sort((a, b) => a.startUserTimestamp - b.startUserTimestamp);
  }

  /** O(n) scan over the chain registry by blockId. Registry is small (bounded by session chain count). */
  findChainEntryByBlockId(blockId: string): ChainCompressionEntry | undefined {
    for (const entry of this.chainRegistry.values()) {
      if (entry.blockId === blockId) return entry;
    }
    return undefined;
  }

  /**
   * Adds all tool calls from a captured batch to the runtime index and
   * persists an IndexEntryData entry to the session via the supplied
   * appendEntry callback. The callback exists so callers can route the
   * append through either `pi.appendEntry` (runtime delivery) or
   * `ctx.sessionManager.appendCustomEntry` (session delivery), without the
   * indexer needing to know which one is active.
   */
  addBatch(
    batch: CapturedBatch,
    appendEntry: (customType: string, data?: unknown) => void,
  ): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
        ...(tc.resultTimestamp !== undefined ? { resultTimestamp: tc.resultTimestamp } : {}),
        ...(tc.spillPath !== undefined ? { spillPath: tc.spillPath } : {}),
        ...(tc.spillBytes !== undefined ? { spillBytes: tc.spillBytes } : {}),
        ...(tc.resultPreview !== undefined ? { resultPreview: tc.resultPreview } : {}),
        ...(tc.contentHash !== undefined ? { contentHash: tc.contentHash } : {}),
      };
      const key = this.indexRecord(record);
      records.push(record);
      // Populate the dedup hash map AFTER the record is indexed so a future
      // flush can dedup against this record. First-seen wins to keep the
      // canonical id stable across multiple identical entries.
      const hash = record.contentHash ?? hashToolResult(record.toolName, record.resultText);
      if (!this.contentHashToOriginal.has(hash)) {
        this.contentHashToOriginal.set(hash, key);
      }
    }

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }

  /**
   * Atomic recoverability backfill for an uncovered chain (spec
   * 2026-08-14-uncovered-chain-deterministic-backfill). Append-before-commit:
   * in-memory maps are touched only after the index entry persisted. Records
   * never seed contentHashToOriginal (dedup poison guard). Refs ride the
   * entry so they survive session restart without a summary message.
   */
  async backfillChainRecords(
    records: ToolCallRecord[],
    opts: {
      spillThreshold: number;
      spillPreviewBytes: number;
      sessionDir: string;
      sessionId: string;
      appendEntry: (customType: string, data?: unknown) => void;
    },
  ): Promise<SummaryToolCallRef[]> {
    for (const r of records) {
      if (r.resultText.length < opts.spillThreshold) continue;
      const key = occKey(r.toolCallId, r.resultTimestamp);
      const path = blobPathFor(opts.sessionDir, opts.sessionId, key);
      await mkdir(blobDirFor(opts.sessionDir, opts.sessionId), { recursive: true });
      await writeFile(path, r.resultText, "utf-8"); // throw = abort backfill (fail-closed)
      applySpill(r, path, opts.spillPreviewBytes);
    }
    const calls = records.map((r) => ({ toolCallId: r.toolCallId, resultTimestamp: r.resultTimestamp }));
    const { refs, nextIndex } = buildShortToolCallRefs(calls, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex; // burned numbers on failure are acceptable (monotonic, opaque)
    opts.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records, backfilled: true, refs } satisfies IndexEntryData);
    for (const r of records) this.indexRecord(r);
    this.registerSummaryRefs(refs);
    return refs;
  }
}
