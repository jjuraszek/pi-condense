import type { ToolCallIndexer } from "./indexer.js";

/**
 * Transforms the `context` event message array, replacing summarized
 * ToolResultMessage entries with short stub messages that point the
 * model at `context_tree_query` for recovery.
 *
 * Why stubs instead of dropping the message entirely:
 *   - Dropping orphans the matching `toolCall` block inside the
 *     preceding AssistantMessage. pi-ai's `transformMessages` then
 *     injects a synthetic `{ role: "toolResult", isError: true,
 *     content: "No result provided" }` for every orphan, which the LLM
 *     reads as a real tool failure. Replacing the toolResult with a
 *     stub keeps role alternation intact and suppresses that injection.
 *   - The stub carries the short ref (`tN`) the model can pass to
 *     `context_tree_query` to recover the raw output, so the breadcrumb
 *     to recovery is present on the toolResult itself, not only in the
 *     separate summary message.
 *
 * Return shape:
 *   - `pruned: true`  — at least one stub-replacement happened; the
 *     returned `messages` is a freshly allocated array.
 *   - `pruned: false` — nothing matched; the returned `messages` is the
 *     **original input array reference** so the caller can cheaply skip
 *     the reconstruction path.
 *
 * AssistantMessage tool-call blocks (which carry the IDs) are kept
 * unchanged so the model can still reference them by id when calling
 * `context_tree_query`.
 */
export function pruneMessages(
  messages: any[],
  indexer: ToolCallIndexer,
): { messages: any[]; pruned: boolean } {
  let pruned = false;
  const next = messages.map((msg) => {
    if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)) {
      pruned = true;
      const ref = indexer.getShortRefForToolCallId(msg.toolCallId) ?? msg.toolCallId;
      return {
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: [
          {
            type: "text",
            text: `[Summarized in pruner summary, ref \`${ref}\`. Use context_tree_query to retrieve full output.]`,
          },
        ],
        isError: false,
        timestamp: msg.timestamp,
      };
    }
    return msg;
  });
  return { messages: pruned ? next : messages, pruned };
}
