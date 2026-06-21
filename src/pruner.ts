import type { ToolCallIndexer } from "./indexer.js";
import type { ChainCompressionConfig, ErrorPurgeConfig, ThinkingStripConfig } from "./types.js";
import { isProtected, type ProtectionConfig } from "./protected.js";
import { applyChainCompressions } from "./chain-range-prune.js";
import { purgeErroredArgs } from "./error-purge.js";
import { stripOldThinking } from "./thinking-strip.js";

/**
 * Estimate of a message array's context weight. Serializing the whole array
 * (not just visible text) is deliberate: it counts tool-call argument bodies
 * (error-purge), thinking blocks (thinking-strip), and tool-result arrays
 * (stub-replace / chain-range) so all reclaim mechanisms register.
 */
export function sizeMessages(messages: any[]): number {
  return JSON.stringify(messages).length;
}

/**
 * Transforms the `context` event message array in two passes:
 *
 * Phase 1 — stub-replace: ToolResultMessages for summarized tool calls are
 * replaced with short stubs pointing the model at `context_tree_query`.
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
 * Phase 2 — error purge: replaces failed toolCall arg bodies with stubs after a
 * cooldown, reclaiming context from large `write`/`edit` arguments that will
 * never succeed. The toolResult error message stays visible.
 *
 * Phase 3 — chain range prune: closed chains older than the rolling window
 * are dropped (middle assistant + toolResult messages) and replaced with a
 * synthetic user message wrapping the existing per-batch summary text.
 * Only runs when `chainCompression.enabled` and chain entries exist.
 *
 * Phase 4 — thinking strip: keep `thinking` blocks only on the last
 * `keepLastTurns` assistant turns; strip them from older assistant messages
 * (preserving text + toolCall). Runs last so the window counts the assistant
 * turns that actually survive to the LLM. Only runs when
 * `thinkingStrip.enabled`.
 *
 * Return shape:
 *   - `pruned: true`  — at least one change happened; the returned
 *     `messages` is a freshly allocated array.
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
  chainCompression?: ChainCompressionConfig,
  errorPurge?: ErrorPurgeConfig,
  thinkingStrip?: ThinkingStripConfig,
  protection?: ProtectionConfig,
): { messages: any[]; pruned: boolean; beforeChars: number; afterChars: number } {
  const beforeChars = sizeMessages(messages);
  // Phase 1: stub-replace summarized tool results
  let pruned = false;
  const next = messages.map((msg) => {
    if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)) {
      const record = indexer.getRecord(msg.toolCallId);
      // Render-time re-check: a record summarized before protectedPaths
      // covered it is repaired here — the raw toolResult still lives in the
      // session JSONL, so skipping the stub restores it verbatim.
      // Dedup aliases resolve to the original record, so an alias whose own
      // path is protected but whose original isn't stays stubbed (edge case).
      if (protection && record && isProtected(record.toolName, record.args, protection)) {
        return msg;
      }
      pruned = true;
      const ref = indexer.getShortRefForToolCallId(msg.toolCallId) ?? msg.toolCallId;
      const text = record?.spillPath
        ? [
            `[Oversized output spilled to file — ${record.spillBytes ?? "?"} bytes.]`,
            `Tool: ${record.toolName}`,
            `Preview (head):`,
            record.resultPreview ?? "",
            `Full output — read this file (offset/limit supported): ${record.spillPath}`,
            `Or use context_tree_query with ref \`${ref}\`.`,
          ].join("\n")
        : `[Summarized in pruner summary, ref \`${ref}\`. Use context_tree_query to retrieve full output.]`;
      return {
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: msg.timestamp,
      };
    }
    return msg;
  });

  let current: any[] = pruned ? next : messages;

  // Phase 2: error purge — replace failed toolCall arg bodies after cooldown
  if (errorPurge?.enabled) {
    const afterPurge = purgeErroredArgs(current, errorPurge);
    if (afterPurge !== current) {
      current = afterPurge;
      pruned = true;
    }
  }

  // Phase 3: chain range prune — drop closed chains beyond the rolling window
  if (chainCompression?.enabled) {
    const chainEntries = indexer.getChainEntries();
    if (chainEntries.length > 0) {
      // Prefer the cohesive LLM range summary (B) when present; fall back to the
      // per-batch concatenation for spans compressed before fusion / on failure.
      const chainSummaryText = (entry: typeof chainEntries[number]): string =>
        entry.rangeSummaryText ?? indexer.getPerBatchSummaryTextForToolCallIds(entry.droppedToolCallIds);
      const blockSummaryLookup = (blockId: string): string | undefined => {
        const entry = indexer.findChainEntryByBlockId(blockId);
        if (!entry) return undefined;
        return chainSummaryText(entry) || undefined;
      };
      const compressed = applyChainCompressions(
        current,
        chainEntries,
        chainSummaryText,
        chainCompression.stripFinalAssistantThinking,
        blockSummaryLookup,
      );
      if (compressed !== current) {
        current = compressed;
        pruned = true;
      }
    }
  }

  // Phase 4: thinking strip — keep thinking only on the last K assistant turns
  if (thinkingStrip?.enabled) {
    const afterStrip = stripOldThinking(current, thinkingStrip);
    if (afterStrip !== current) {
      current = afterStrip;
      pruned = true;
    }
  }

  return { messages: current, pruned, beforeChars, afterChars: pruned ? sizeMessages(current) : beforeChars };
}
