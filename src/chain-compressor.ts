import { CUSTOM_TYPE_CHAIN } from "./types.js";
import type { ChainRange, ChainCompressionEntry } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import type { BlockRefIssuer } from "./block-refs.js";
import { bareToolCallId, parseOccKey } from "./occurrence-key.js";

/**
 * Grace ids are keyed the same way `recovery-grace.ts` keys them: occurrence
 * (`id@timestamp`) when the recovery message carried a timestamp, bare id
 * otherwise. A chain's middles are compared occurrence-first (exact match on
 * `middleOccurrenceKeys`, falling back to `middleToolCallIds` for chains built
 * before the field existed), so a graced occurrence never defers a chain
 * holding a DIFFERENT occurrence of the same reused provider id. The only
 * bare-to-bare fallback is for grace entries that themselves have no
 * timestamp discriminant — there is no exact key to compare in that case.
 */
function chainMatchesGrace(chain: ChainRange, inGraceToolCallIds: Set<string>): boolean {
  const keys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;
  if (keys.some((k) => inGraceToolCallIds.has(k))) return true;
  for (const g of inGraceToolCallIds) {
    if (parseOccKey(g).resultTimestamp === undefined && keys.some((k) => bareToolCallId(k) === g)) return true;
  }
  return false;
}

/**
 * Pure eligibility filter: given all detected chains, return the subset
 * that should be compressed — closed, not already compressed, and older
 * than the rolling window.
 *
 * Extracted for unit testing without needing a real indexer or appendEntry.
 *
 * @param chains Must be in chronological order (oldest first), as emitted by
 *   chain-detector. Ordering is not validated here; out-of-order input silently
 *   picks wrong chains because the rolling-window slice is positional.
 * @param inGraceToolCallIds Recovery ids still within their grace window. Chains
 *   spanning one of these ids are deferred from compression, but the rolling-window
 *   boundary itself is computed BEFORE grace exclusion, so a grace-protected chain
 *   never shrinks the window buffer or shifts which other chains become eligible.
 */
export function selectEligible(
  chains: ChainRange[],
  rollingWindow: number,
  alreadyCompressed: Set<number>,
  inGraceToolCallIds: Set<string> = new Set(),
): ChainRange[] {
  const candidates = chains.filter(
    (c) =>
      c.finalAssistantTimestamp !== null &&
      !alreadyCompressed.has(c.startUserTimestamp) &&
      c.middleToolCallIds.length > 0,
  );
  const toCompress = candidates.slice(0, Math.max(0, candidates.length - rollingWindow));
  return toCompress.filter((c) => !chainMatchesGrace(c, inGraceToolCallIds));
}

/**
 * The subset of ToolCallIndexer that compressEligible actually uses.
 * Accepting this narrower interface keeps the function testable without a full indexer
 * and documents its real dependency surface.
 */
export interface ChainCompressorIndexerDeps {
  getChainEntries(): import("./types.js").ChainCompressionEntry[];
  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
  getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[];
  getToolRefsForToolCallIds(toolCallIds: string[]): string[];
  registerChain(entry: import("./types.js").ChainCompressionEntry): void;
}

export interface CompressEligibleDeps {
  indexer: ChainCompressorIndexerDeps;
  blockRefs: BlockRefIssuer;
  /** pi.appendEntry binding — routes to session or runtime depending on caller context */
  appendEntry: (customType: string, data: unknown) => void;
  /** Injectable clock for deterministic tests */
  now: () => number;
  /**
   * Optional range-summary fuser (B). When present, a span with >= 2 per-batch
   * summaries gets one LLM call fusing them into a cohesive `rangeSummaryText`.
   * Returning null (or throwing) is non-fatal: the chain still compresses and
   * the renderer falls back to the per-batch concatenation.
   */
  fuseRange?: (perBatchSummaryText: string) => Promise<string | null>;
}

export interface CompressEligibleResult {
  compressedEntries: ChainCompressionEntry[];
  skipped: Array<{ startUserTimestamp: number; reason: "no-summary" | "already-compressed" }>;
}

/**
 * Compresses all chains that are outside the rolling window.
 * Reads existing chain state from the indexer so calls are safe to repeat
 * (already-compressed chains are detected and reported, not double-compressed).
 */
export async function compressEligible(
  chains: ChainRange[],
  rollingWindow: number,
  deps: CompressEligibleDeps,
  inGraceToolCallIds: Set<string> = new Set(),
): Promise<CompressEligibleResult> {
  const alreadyCompressedTimestamps = new Set(
    deps.indexer.getChainEntries().map((e) => e.startUserTimestamp),
  );

  const skipped: CompressEligibleResult["skipped"] = [];

  // Report already-compressed closed chains for observability.
  for (const chain of chains) {
    if (chain.finalAssistantTimestamp !== null && alreadyCompressedTimestamps.has(chain.startUserTimestamp)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "already-compressed" });
    }
  }

  const eligible = selectEligible(chains, rollingWindow, alreadyCompressedTimestamps, inGraceToolCallIds);

  const compressedEntries: ChainCompressionEntry[] = [];
  for (const chain of eligible) {
    // summaryBodies / toolRefs live in occurrence-key space (src/indexer.ts).
    // Bare ids would match nothing and silently skip every chain.
    const lookupKeys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;

    if (!deps.indexer.hasPerBatchSummaryCoveringAny(lookupKeys)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }

    const blockId = deps.blockRefs.issue();
    const toolRefs = deps.indexer.getToolRefsForToolCallIds(lookupKeys);

    // B: fuse this span's per-batch summaries into one cohesive summary.
    // Gated on >= 2 summaries (nothing to fuse otherwise). Non-fatal.
    let rangeSummaryText: string | undefined;
    if (deps.fuseRange) {
      const summaries = deps.indexer.getPerBatchSummariesForToolCallIds(lookupKeys);
      if (summaries.length >= 2) {
        try {
          const fused = await deps.fuseRange(summaries.join("\n\n"));
          if (fused && fused.trim()) rangeSummaryText = fused;
        } catch {
          // fall back to the per-batch concatenation at render time
        }
      }
    }

    const entry: ChainCompressionEntry = {
      blockId,
      startUserTimestamp: chain.startUserTimestamp,
      droppedToolCallIds: chain.middleToolCallIds,
      finalAssistantTimestamp: chain.finalAssistantTimestamp,
      toolRefs,
      compressedAt: deps.now(),
      ...(rangeSummaryText ? { rangeSummaryText } : {}),
      ...(chain.protectedToolCallIds?.length ? { protectedToolCallIds: chain.protectedToolCallIds } : {}),
      ...(chain.middleOccurrenceKeys?.length ? { droppedOccurrenceKeys: chain.middleOccurrenceKeys } : {}),
    };

    deps.appendEntry(CUSTOM_TYPE_CHAIN, entry);
    deps.indexer.registerChain(entry);
    compressedEntries.push(entry);
  }

  return { compressedEntries, skipped };
}
