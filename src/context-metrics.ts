import { detectChains } from "./chain-detector.js";
import { occKey, resultTimestampOf } from "./occurrence-key.js";
import type { ContextMetricsSnapshot, PruneFrontier } from "./types.js";

function charsOf(msg: any): number {
  return JSON.stringify(msg).length;
}

function tokensOf(msg: any): number {
  return Math.round(charsOf(msg) / 4);
}

function isTextOnlyAssistant(msg: any): boolean {
  if (msg.role !== "assistant") return false;
  if (!Array.isArray(msg.content)) return true;
  return !msg.content.some((b: any) => b.type === "toolCall");
}

function toolCallBlocksOf(msg: any): { id: string; input?: unknown; arguments?: unknown }[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b: any) => b.type === "toolCall");
}

function findArgsForToolCallId(branch: any[], resultIdx: number, toolCallId: string): unknown {
  for (let i = resultIdx - 1; i >= 0; i--) {
    const m = branch[i];
    if (m.role !== "assistant") continue;
    const call = toolCallBlocksOf(m).find((c) => c.id === toolCallId);
    if (call) return (call as any).input ?? (call as any).arguments;
  }
  return undefined;
}

/**
 * Pure snapshot of what the pruner cannot (yet) reclaim: thinking tokens
 * trapped in the trailing open cycle, the largest single chain's share of
 * the branch, and unsummarized toolResult tokens past the prune frontier.
 */
export function computeContextMetrics(
  branch: any[],
  frontier: PruneFrontier | null,
  isSummarized: (occurrenceKey: string) => boolean,
  isProtected: (toolName: string, args: unknown) => boolean,
): ContextMetricsSnapshot {
  if (branch.length === 0) {
    return { openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 };
  }

  // ── Open segment: strictly after the last text-only assistant ──────────
  let lastTextOnlyIdx = -1;
  for (let i = 0; i < branch.length; i++) {
    if (isTextOnlyAssistant(branch[i])) lastTextOnlyIdx = i;
  }
  const openStart = lastTextOnlyIdx + 1;

  let thinkingChars = 0;
  for (let i = openStart; i < branch.length; i++) {
    const m = branch[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "thinking") thinkingChars += JSON.stringify(block).length;
    }
  }
  const openCycleThinkingTokens = Math.round(thinkingChars / 4);

  // ── Largest chain share ─────────────────────────────────────────────────
  const branchChars = branch.map(charsOf);
  const sumChars = (start: number, end: number): number => {
    let sum = 0;
    for (let i = start; i <= end; i++) sum += branchChars[i];
    return sum;
  };
  const totalChars = branchChars.reduce((a, b) => a + b, 0);

  const chains = detectChains(branch, isProtected);
  let largestClosedChainChars = 0;
  for (const range of chains) {
    const startIdx = branch.findIndex((m) => m.role === "user" && m.timestamp === range.startUserTimestamp);
    if (startIdx === -1) continue;
    let endIdx: number;
    if (range.finalAssistantTimestamp !== null) {
      endIdx = branch.findIndex(
        (m, i) => i >= startIdx && m.role === "assistant" && m.timestamp === range.finalAssistantTimestamp,
      );
      if (endIdx === -1) continue;
    } else {
      let nextUserIdx = -1;
      for (let i = startIdx + 1; i < branch.length; i++) {
        if (branch[i].role === "user") {
          nextUserIdx = i;
          break;
        }
      }
      endIdx = nextUserIdx === -1 ? branch.length - 1 : nextUserIdx - 1;
    }
    if (endIdx < startIdx) continue;
    const chainChars = sumChars(startIdx, endIdx);
    if (chainChars > largestClosedChainChars) largestClosedChainChars = chainChars;
  }

  const openSegmentChars = openStart < branch.length ? sumChars(openStart, branch.length - 1) : 0;
  const numerator = Math.max(largestClosedChainChars, openSegmentChars);
  const largestChainSharePct = totalChars === 0 ? 0 : Math.round((100 * numerator) / totalChars);

  // ── Frontier gap ─────────────────────────────────────────────────────────
  // Exclusion is positional: only toolResults belonging to the boundary turn's
  // own calls (up to and including the last-attempted call) are excluded.
  // Ids are only unique per turn (see occurrence-key.ts), so a later turn may
  // legally reuse a bare id — its result must still count toward the gap.
  let boundaryIdx = -1;
  let boundaryTurnEndIdx = branch.length;
  const boundaryExcludedIds = new Set<string>();
  if (frontier) {
    let counter = 0;
    for (let i = 0; i < branch.length; i++) {
      const m = branch[i];
      if (m.role !== "assistant") continue;
      const turnIdx = counter;
      counter++;
      if (turnIdx === frontier.lastAttemptedTurnIndex) {
        const calls = toolCallBlocksOf(m);
        const k = calls.findIndex((c) => c.id === frontier.lastAttemptedToolCallId);
        if (k !== -1) {
          boundaryIdx = i;
          for (let j = 0; j <= k; j++) boundaryExcludedIds.add(calls[j].id);
          for (let j = i + 1; j < branch.length; j++) {
            if (branch[j].role === "assistant") {
              boundaryTurnEndIdx = j;
              break;
            }
          }
        }
        break;
      }
    }
  }

  let frontierGapTokens = 0;
  const scanStart = boundaryIdx === -1 ? 0 : boundaryIdx + 1;
  for (let i = scanStart; i < branch.length; i++) {
    const m = branch[i];
    if (m.role !== "toolResult") continue;
    if (i < boundaryTurnEndIdx && boundaryExcludedIds.has(m.toolCallId)) continue;
    const key = occKey(m.toolCallId, resultTimestampOf(m.timestamp));
    if (isSummarized(key)) continue;
    const args = findArgsForToolCallId(branch, i, m.toolCallId);
    if (isProtected(m.toolName, args)) continue;
    frontierGapTokens += tokensOf(m);
  }

  return { openCycleThinkingTokens, largestChainSharePct, frontierGapTokens };
}
