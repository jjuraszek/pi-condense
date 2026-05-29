import { CUSTOM_TYPE_CHAIN } from "./types.js";
import type { ChainRange, ChainCompressionEntry } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import type { BlockRefIssuer } from "./block-refs.js";

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
 */
export function selectEligible(
  chains: ChainRange[],
  rollingWindow: number,
  alreadyCompressed: Set<number>,
): ChainRange[] {
  const candidates = chains.filter(
    (c) =>
      c.finalAssistantTimestamp !== null &&
      !alreadyCompressed.has(c.startUserTimestamp) &&
      c.middleToolCallIds.length > 0,
  );
  return candidates.slice(0, Math.max(0, candidates.length - rollingWindow));
}

/**
 * The subset of ToolCallIndexer that compressEligible actually uses.
 * Accepting this narrower interface keeps the function testable without a full indexer
 * and documents its real dependency surface.
 */
export interface ChainCompressorIndexerDeps {
  getChainEntries(): import("./types.js").ChainCompressionEntry[];
  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
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
export function compressEligible(
  chains: ChainRange[],
  rollingWindow: number,
  deps: CompressEligibleDeps,
): CompressEligibleResult {
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

  const eligible = selectEligible(chains, rollingWindow, alreadyCompressedTimestamps);

  const compressedEntries: ChainCompressionEntry[] = [];
  for (const chain of eligible) {
    if (!deps.indexer.hasPerBatchSummaryCoveringAny(chain.middleToolCallIds)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }

    const blockId = deps.blockRefs.issue();
    const toolRefs = deps.indexer.getToolRefsForToolCallIds(chain.middleToolCallIds);
    const entry: ChainCompressionEntry = {
      blockId,
      startUserTimestamp: chain.startUserTimestamp,
      droppedToolCallIds: chain.middleToolCallIds,
      finalAssistantTimestamp: chain.finalAssistantTimestamp,
      toolRefs,
      compressedAt: deps.now(),
    };

    deps.appendEntry(CUSTOM_TYPE_CHAIN, entry);
    deps.indexer.registerChain(entry);
    compressedEntries.push(entry);
  }

  return { compressedEntries, skipped };
}
