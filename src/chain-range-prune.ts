import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import type { ChainCompressionEntry } from "./types.js";
import { substituteBlockRefs } from "./nested-placeholders.js";
import { extractToolResultText } from "./batch-capture.js";
import { bareToolCallId, occKey, resultTimestampOf } from "./occurrence-key.js";
import type { DiagnosticSink } from "./diagnostics.js";

export function isPerBatchSummaryMessage(msg: any): boolean {
  return msg.role === "custom" && msg.customType === CUSTOM_TYPE_SUMMARY;
}

/** Refs a per-batch summary message carries, as (toolCallId, resultTimestamp) pairs. */
function summaryRefs(msg: any): { toolCallId: string; resultTimestamp?: number }[] {
  return msg.details?.toolCallRefs ?? [];
}

/**
 * A ref with a `resultTimestamp` is matched by exact occurrence key against
 * `droppedOccKeys` - a live turn reusing a dropped chain's bare id must not
 * suppress that live turn's summary. A ref with no `resultTimestamp` (legacy)
 * falls back to bare-id membership in `droppedBareIds`, since no occurrence
 * discriminant was ever recorded for it.
 */
export function perBatchSummaryOverlapsDropped(
  msg: any,
  droppedOccKeys: Set<string>,
  droppedBareIds: Set<string>,
): boolean {
  return summaryRefs(msg).some((r) =>
    r.resultTimestamp !== undefined
      ? droppedOccKeys.has(occKey(r.toolCallId, r.resultTimestamp))
      : droppedBareIds.has(bareToolCallId(r.toolCallId)),
  );
}

export function withoutThinkingBlocks(msg: AssistantMessage): AssistantMessage {
  return { ...msg, content: msg.content.filter((c) => c.type !== "thinking") };
}

export function buildSyntheticChainMessage(
  entry: ChainCompressionEntry,
  summary: string,
  blockSummaryLookup?: (blockId: string) => string | undefined,
  protectedOutputs: { tool: string; text: string }[] = [],
): UserMessage {
  const resolvedSummary = blockSummaryLookup
    ? substituteBlockRefs(summary, blockSummaryLookup, { selfBlockId: entry.blockId })
    : summary;
  const tools = entry.toolRefs.join(",");
  const protectedBlocks = protectedOutputs
    .map((p) => `\n\n<protected-output tool="${p.tool}">\n${p.text}\n</protected-output>`)
    .join("");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<compressed-chain id="${entry.blockId}" tools="${tools}">\n${resolvedSummary}${protectedBlocks}\n</compressed-chain>`,
      },
    ],
    // compressedAt is the deterministic timestamp — set at compression-decision time,
    // never collides with real user messages whose timestamps come from the live session clock
    timestamp: entry.compressedAt,
  };
}

/**
 * Resolves a persisted chain entry to a positional index range.
 *
 * Role-gated and unique-match-or-nothing: exactly one user message at
 * startUserTimestamp, exactly one assistant at finalAssistantTimestamp, and
 * start < end. Otherwise null - the entry drops nothing. Fail-closed is the
 * whole point: an id-set or timestamp-window fallback is what deleted live
 * turns (doc/specs/2026-08-12-toolcall-id-collisions.md).
 */
export function resolveRange(
  entry: Pick<ChainCompressionEntry, "startUserTimestamp" | "finalAssistantTimestamp">,
  messages: any[],
): { startIndex: number; endIndex: number } | null {
  if (entry.finalAssistantTimestamp === null) return null;
  let startIndex = -1;
  let startMatches = 0;
  let endIndex = -1;
  let endMatches = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && msg.timestamp === entry.startUserTimestamp) {
      startMatches++;
      if (startIndex < 0) startIndex = i;
    } else if (msg.role === "assistant" && msg.timestamp === entry.finalAssistantTimestamp) {
      endMatches++;
      if (endIndex < 0) endIndex = i;
    }
  }
  if (startMatches !== 1 || endMatches !== 1) return null;
  if (!(startIndex < endIndex)) return null;
  return { startIndex, endIndex };
}

export function applyChainCompressions(
  messages: any[],
  chainEntries: ChainCompressionEntry[],
  summaryTextForChain: (entry: ChainCompressionEntry) => string,
  stripFinalThinking: boolean,
  blockSummaryLookup?: (blockId: string) => string | undefined,
  diagnostics?: DiagnosticSink,
): any[] {
  if (chainEntries.length === 0) return messages;

  // Pre-scan: collect blockIds of synthetic chain messages already in the input.
  // Skipping re-insertion for matching blockIds makes the transform idempotent —
  // calling twice with the same chainEntries yields the same output.
  const existingSyntheticBlockIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user") {
      const text: string = msg.content?.[0]?.text ?? "";
      const m = /^<compressed-chain id="([^"]+)"/.exec(text);
      if (m) existingSyntheticBlockIds.add(m[1]);
    }
  }

  // 1. resolve every entry to a range; unresolved entries contribute nothing
  const resolved: { entry: ChainCompressionEntry; startIndex: number; endIndex: number }[] = [];
  for (const entry of chainEntries) {
    const range = resolveRange(entry, messages);
    if (!range) {
      diagnostics?.report(
        "unresolved-range",
        entry.blockId,
        `blockId=${entry.blockId} start=${entry.startUserTimestamp} final=${entry.finalAssistantTimestamp}`,
      );
      continue;
    }
    resolved.push({ entry, ...range });
  }

  // 2. drop entries nested inside another entry's range, and de-duplicate
  //    entries that resolved to the same startIndex (one synthetic per slot)
  const accepted: typeof resolved = [];
  const claimedStart = new Set<number>();
  for (const candidate of resolved) {
    const loser = resolved.find(
      (other) => other !== candidate && candidate.startIndex > other.startIndex && candidate.startIndex < other.endIndex,
    );
    if (loser || claimedStart.has(candidate.startIndex)) {
      // Same DiagnosticKind as a genuinely unresolvable boundary, but a
      // distinct dedup-key prefix: this is a benign, expected skip (nested or
      // duplicate range), not a compression failure. Keeping the kind fixed
      // to the spec's set while still making the two cases greppable.
      diagnostics?.report(
        "unresolved-range",
        `overlap:${candidate.entry.blockId}`,
        loser
          ? `blockId=${candidate.entry.blockId} skipped: range nests inside blockId=${loser.entry.blockId}`
          : `blockId=${candidate.entry.blockId} skipped: range duplicates startIndex=${candidate.startIndex} already claimed`,
      );
      continue;
    }
    claimedStart.add(candidate.startIndex);
    accepted.push(candidate);
  }

  if (accepted.length === 0) return messages;

  // 3. index sets + per-entry facts
  const dropIndices = new Set<number>();
  const stripAtIndex = new Set<number>();
  const insertAfterIndex = new Map<number, { synthetic: any; blockId: string }>();
  const droppedBareIds = new Set<string>();
  const droppedOccKeys = new Set<string>();
  const protectedByBlock = new Map<string, { tool: string; text: string }[]>();

  for (const { entry, startIndex, endIndex } of accepted) {
    const protectedIds = new Set(entry.protectedToolCallIds ?? []);
    const inRangeBareIds: string[] = [];
    for (let i = startIndex + 1; i < endIndex; i++) {
      const msg = messages[i];
      dropIndices.add(i);
      if (msg.role === "toolResult") {
        inRangeBareIds.push(msg.toolCallId);
        droppedBareIds.add(msg.toolCallId);
        droppedOccKeys.add(occKey(msg.toolCallId, resultTimestampOf(msg.timestamp)));
        if (protectedIds.has(msg.toolCallId)) {
          const arr = protectedByBlock.get(entry.blockId) ?? [];
          arr.push({ tool: msg.toolName, text: extractToolResultText(msg) });
          protectedByBlock.set(entry.blockId, arr);
        }
      } else if (msg.role === "assistant") {
        for (const block of msg.content ?? []) {
          if (block.type === "toolCall") {
            inRangeBareIds.push(block.id);
            droppedBareIds.add(block.id);
          }
        }
      }
    }
    // Diagnostic-only cross-check: the range always wins.
    const recorded = new Set((entry.droppedToolCallIds ?? []).map(bareToolCallId));
    const actual = new Set(inRangeBareIds);
    if (recorded.size !== actual.size || [...recorded].some((id) => !actual.has(id))) {
      diagnostics?.report(
        "range-id-mismatch",
        entry.blockId,
        `blockId=${entry.blockId} recorded=${recorded.size} actual=${actual.size}`,
      );
    }
    if (stripFinalThinking) stripAtIndex.add(endIndex);
    insertAfterIndex.set(startIndex, {
      synthetic: buildSyntheticChainMessage(
        entry,
        summaryTextForChain(entry),
        blockSummaryLookup,
        protectedByBlock.get(entry.blockId) ?? [],
      ),
      blockId: entry.blockId,
    });
  }

  // 4. emit. Drops are role-restricted: user-role messages (including the
  //    already-inserted synthetic, which is user-role) and third-party custom
  //    messages inside a range are preserved. Preserving the synthetic is what
  //    makes re-application a true no-op.
  const out: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isSummary = isPerBatchSummaryMessage(msg);
    const droppable = msg.role === "assistant" || msg.role === "toolResult" || isSummary;
    if (dropIndices.has(i) && droppable) continue;
    // Coverage, not index membership: in agent-message batching the per-batch
    // summary is appended AFTER finalAssistantTimestamp, outside the range.
    if (isSummary && perBatchSummaryOverlapsDropped(msg, droppedOccKeys, droppedBareIds)) continue;

    if (msg.role === "assistant" && stripAtIndex.has(i)) out.push(withoutThinkingBlocks(msg));
    else out.push(msg);

    const info = insertAfterIndex.get(i);
    if (info && !existingSyntheticBlockIds.has(info.blockId)) out.push(info.synthetic);
  }
  return out;
}
