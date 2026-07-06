import { QUERY_TOOL_NAME } from "./types.js";

/**
 * Set of `context_tree_query` toolCallIds still inside the recovery grace
 * window, computed positionally from the message array (no stored metadata).
 *
 * A recovery output's "user-turn-group" is the count of `role === "user"`
 * messages at or before its position; its age is `nowUTG - that count`, where
 * `nowUTG` is the total user messages in the array. It is in grace while
 * `age <= graceTurns`. Works uniformly for render-context and session-branch
 * arrays, so pruner Phase 1 and chain-compressor eligibility share one rule.
 *
 * `graceTurns <= 0` returns an empty set (feature disabled).
 */
export function inGraceRecoveryToolCallIds(messages: any[], graceTurns: number): Set<string> {
  const result = new Set<string>();
  if (!(graceTurns > 0)) return result;

  let nowUTG = 0;
  for (const m of messages) if (m?.role === "user") nowUTG++;

  let seen = 0;
  for (const m of messages) {
    if (m?.role === "user") {
      seen++;
      continue;
    }
    if (m?.role === "toolResult" && m.toolName === QUERY_TOOL_NAME && typeof m.toolCallId === "string") {
      if (nowUTG - seen <= graceTurns) result.add(m.toolCallId);
    }
  }
  return result;
}
