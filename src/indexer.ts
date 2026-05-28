import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  CapturedBatch,
  DedupAliasEntryData,
  IndexEntryData,
  ToolCallRecord,
} from "./types.js";
import {
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

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();
  private aliasToToolCallId = new Map<string, string>();
  private toolCallIdToAlias = new Map<string, string>();
  private nextShortAliasNumber = 1;
  /**
   * hash → original toolCallId. Populated as records enter the indexer
   * (`addBatch`) and on `reconstructFromSession`. Drives the pre-flush
   * dedup pass via `lookupByContent`.
   */
  private contentHashToOriginal = new Map<string, string>();
  /**
   * Duplicate toolCallId → original toolCallId. Populated by
   * `registerDuplicate` during the pre-flush dedup pass and rebuilt from
   * CUSTOM_TYPE_DEDUP_ALIAS entries on reconstruction.
   *
   * Both `isSummarized` and `resolveToolCallId` consult this map so
   * `pruneMessages` stub-replaces dup toolResults and `context_tree_query`
   * resolves dup ids to the original record.
   */
  private dedupAliasToOriginal = new Map<string, string>();

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.aliasToToolCallId.clear();
    this.toolCallIdToAlias.clear();
    this.contentHashToOriginal.clear();
    this.dedupAliasToOriginal.clear();
    this.nextShortAliasNumber = 1;

    // Two passes so dedup aliases land AFTER the original short refs they
    // need to reuse, regardless of the underlying append order.
    const branch = ctx.sessionManager.getBranch();
    const dedupAliasEntries: DedupAliasEntryData[] = [];

    for (const entry of branch) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            this.index.set(toolCall.toolCallId, toolCall);
            // First-seen wins so the contentHashToOriginal map matches what
            // addBatch would have produced at append time.
            const hash = hashToolResult(toolCall.toolName, toolCall.resultText);
            if (!this.contentHashToOriginal.has(hash)) {
              this.contentHashToOriginal.set(hash, toolCall.toolCallId);
            }
          }
        }
        continue;
      }

      if (entry.type === "custom_message" && (entry as any).customType === CUSTOM_TYPE_SUMMARY) {
        const refs = normalizeSummaryToolCallRefs((entry as any).details);
        this.registerSummaryRefs(refs);
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
      this.dedupAliasToOriginal.set(data.newToolCallId, data.originalToolCallId);
      const originalShortRef = this.toolCallIdToAlias.get(data.originalToolCallId);
      if (originalShortRef) {
        // Keep `getShortRefForToolCallId(dupId)` returning the SAME short ref
        // as the original so pruneMessages emits a consistent `tN` for both.
        this.toolCallIdToAlias.set(data.newToolCallId, originalShortRef);
      }
    }
  }

  /**
   * Returns true if the given toolCallId has been pruned — either because
   * its full record is in the index, or because it has been registered as
   * an alias of an already-indexed original via the content-hash dedup pass.
   *
   * `pruneMessages` uses this to decide whether to stub-replace a
   * ToolResultMessage; both cases need the same treatment.
   */
  isSummarized(toolCallId: string): boolean {
    return this.index.has(toolCallId) || this.dedupAliasToOriginal.has(toolCallId);
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
      if (ref.shortId !== ref.toolCallId) {
        this.aliasToToolCallId.set(ref.shortId, ref.toolCallId);
        this.toolCallIdToAlias.set(ref.toolCallId, ref.shortId);
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
    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const { refs, nextIndex } = buildShortToolCallRefs(toolCallIds, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  /**
   * Resolve a short alias, a duplicate's toolCallId, or a full toolCallId
   * to the canonical toolCallId backing it.
   *
   * Order:
   *   1. Direct hit in `this.index` (canonical id).
   *   2. Dedup alias → underlying original toolCallId.
   *   3. Short-ref (`t3`) → underlying toolCallId.
   *
   * Used by `getRecord`/`lookupToolCalls` so `context_tree_query` returns
   * the original record for both short refs and dedup'd ids.
   */
  resolveToolCallId(toolCallIdOrAlias: string): string | undefined {
    if (this.index.has(toolCallIdOrAlias)) return toolCallIdOrAlias;
    const dedupTarget = this.dedupAliasToOriginal.get(toolCallIdOrAlias);
    if (dedupTarget) return dedupTarget;
    return this.aliasToToolCallId.get(toolCallIdOrAlias);
  }

  /**
   * Returns the short alias (e.g. "t1") registered for the given
   * toolCallId, or undefined if none was registered. Legacy summaries
   * written before short-refs were introduced map shortId === toolCallId
   * and intentionally return undefined here so callers (e.g. the
   * pruner stub) can fall back to the toolCallId itself.
   */
  getShortRefForToolCallId(toolCallId: string): string | undefined {
    return this.toolCallIdToAlias.get(toolCallId);
  }

  /**
   * Look up a single record by toolCallId or short alias (used by query tool).
   */
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (!resolved) return undefined;
    return this.index.get(resolved);
  }

  /**
   * Looks up multiple tool call records by ID. Skips any IDs not found.
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
   * Registers `newToolCallId` as a duplicate of `originalToolCallId`. The new
   * id reuses the original's short alias (so `pruneMessages` emits the same
   * `tN` ref for both) and is persisted via the supplied `appendEntry` so
   * reconstruction can replay it later.
   *
   * No-op when `newToolCallId === originalToolCallId` (defensive).
   */
  registerDuplicate(
    newToolCallId: string,
    originalToolCallId: string,
    appendEntry: (customType: string, data?: unknown) => void,
  ): void {
    if (newToolCallId === originalToolCallId) return;
    this.dedupAliasToOriginal.set(newToolCallId, originalToolCallId);
    const originalShortRef = this.toolCallIdToAlias.get(originalToolCallId);
    if (originalShortRef) {
      this.toolCallIdToAlias.set(newToolCallId, originalShortRef);
    }
    const payload: DedupAliasEntryData = { newToolCallId, originalToolCallId };
    appendEntry(CUSTOM_TYPE_DEDUP_ALIAS, payload);
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
      };
      this.index.set(record.toolCallId, record);
      records.push(record);
      // Populate the dedup hash map AFTER the record is indexed so a future
      // flush can dedup against this record. First-seen wins to keep the
      // canonical id stable across multiple identical entries.
      const hash = hashToolResult(record.toolName, record.resultText);
      if (!this.contentHashToOriginal.has(hash)) {
        this.contentHashToOriginal.set(hash, record.toolCallId);
      }
    }

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }
}
