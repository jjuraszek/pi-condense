import { QUERY_TOOL_NAME } from "./types.js";
import { occKey } from "./occurrence-key.js";

/**
 * Recovery occurrence keys (or bare ids when the message carries no timestamp)
 * still inside the grace window, computed positionally (no stored metadata).
 * Direct `context_tree_query` results and tool results whose recorded nested
 * calls include that name qualify; grace covers the whole outer result.
 *
 * Keyed by occurrence, not bare id: the pruner's fail-closed ladder in
 * `pruneMessages` looks this set up with the SAME `occKey(id, timestamp)` it
 * computed for the message under test, so a graced occurrence never leaks
 * protection onto a different, later occurrence that happens to reuse the
 * same provider id.
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
    if (m?.role === "toolResult" && typeof m.toolCallId === "string" && (
      m.toolName === QUERY_TOOL_NAME ||
      (Array.isArray(m.nestedCalls?.calls) && m.nestedCalls.calls.some((call: any) => call?.name === QUERY_TOOL_NAME))
    )) {
      const key = typeof m.timestamp === "number" ? occKey(m.toolCallId, m.timestamp) : m.toolCallId;
      if (nowUTG - seen <= graceTurns) result.add(key);
    }
  }
  return result;
}
