import { createHash } from "node:crypto";
import type { ToolCallIndexer } from "./indexer.js";
import type { ChainCompressionConfig, ErrorPurgeConfig } from "./types.js";
import { isProtected, type ProtectionConfig } from "./protected.js";
import { applyChainCompressions } from "./chain-range-prune.js";
import { purgeErroredArgs } from "./error-purge.js";
import { inGraceRecoveryToolCallIds } from "./recovery-grace.js";
import { occKey } from "./occurrence-key.js";
import { sweepOrphanToolResults } from "./orphan-sweep.js";
import type { DiagnosticSink } from "./diagnostics.js";

/**
 * Estimate of a message array's context weight. Serializing the whole array
 * (not just visible text) is deliberate: it counts tool-call argument bodies
 * (error-purge) and tool-result arrays (stub-replace / chain-range) so all
 * reclaim mechanisms register.
 */
export function sizeMessages(messages: any[]): number {
  return JSON.stringify(messages).length;
}

/**
 * Transforms the `context` event message array in four phases:
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
 * Phase 4 — orphan sweep: structural post-condition run unconditionally over
 * the final array. Removes any toolResult whose matching toolCall id was not
 * opened by the immediately preceding assistant turn (per-turn open set, not
 * cumulative — see src/orphan-sweep.ts). Reference-preserving when nothing is
 * swept, so a clean render still returns the identical input array.
 *
 * Return shape:
 *   - `pruned: true`  — at least one change happened; the returned
 *     `messages` is a freshly allocated array.
 *   - `pruned: false` — nothing matched; the returned `messages` is the
 *     **original input array reference** so the caller can cheaply skip
 *     the reconstruction path.
 *   - `beforeChars` / `afterChars` — serialized context size (`sizeMessages`)
 *     before and after pruning when `pruned` is true. When `pruned` is false
 *     both are `0`: a no-op sentinel, not a measurement — the size is never
 *     computed on the no-op path (zero `JSON.stringify` over the array), and
 *     the only consumer (`index.ts` live-reclaim) reads them solely under
 *     `if (result.pruned)`.
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
  protection?: ProtectionConfig,
  recoveryGraceTurns: number = 0,
  diagnostics?: DiagnosticSink,
): { messages: any[]; pruned: boolean; beforeChars: number; afterChars: number } {
  // Phase 1: stub-replace summarized tool results
  let pruned = false;
  const inGrace = inGraceRecoveryToolCallIds(messages, recoveryGraceTurns);
  const next = messages.map((msg) => {
    if (msg.role !== "toolResult") return msg;

    // Fail-closed: when the message carries a timestamp, the occurrence key
    // is tried first. The bare id is consulted only as a fallback, and only
    // when `hasLegacyBareRecord` confirms it is LEGACY-ONLY (no occurrence
    // siblings) - a mixed bare+occurrence id fails closed there too, since a
    // live result under a reused id is not the legacy one. A permissive
    // bare-id fallback would stub a live result because an older occurrence
    // (or the legacy record) of the same provider id was summarized.
    const key = typeof msg.timestamp === "number" ? occKey(msg.toolCallId, msg.timestamp) : msg.toolCallId;
    const lookupKey = indexer.isSummarized(key)
      ? key
      : indexer.hasLegacyBareRecord(msg.toolCallId)
        ? msg.toolCallId
        : undefined;
    if (lookupKey === undefined) return msg;

    const record = indexer.getRecord(lookupKey);
    // Render-time re-check: a record summarized before protectedPaths
    // covered it is repaired here — the raw toolResult still lives in the
    // session JSONL, so skipping the stub restores it verbatim.
    // Dedup aliases resolve to the original record, so an alias whose own
    // path is protected but whose original isn't stays stubbed (edge case).
    if (protection && record && isProtected(record.toolName, record.args, protection)) {
      return msg;
    }
    if (inGrace.has(key)) {
      return msg;
    }
    pruned = true;
    const ref = indexer.getShortRefForToolCallId(lookupKey) ?? msg.toolCallId;
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
        entry.rangeSummaryText ??
        indexer.getPerBatchSummaryTextForToolCallIds(entry.droppedOccurrenceKeys ?? entry.droppedToolCallIds);
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
        diagnostics,
      );
      if (compressed !== current) {
        current = compressed;
        pruned = true;
      }
    }
  }

  // Phase 4: orphan sweep — structural post-condition. Reference-preserving
  // when clean, so a no-op render leaves the prompt-cache prefix untouched.
  const swept = sweepOrphanToolResults(current);
  if (swept.messages !== current) {
    current = swept.messages;
    pruned = true;
    const sortedIds = [...swept.sweptIds].sort();
    // Hash the id list into a short, stable dedup key instead of the raw
    // sorted join: a growing orphan set would otherwise write ever-longer
    // keys ("a", "a,b", "a,b,c", ...), and DiagnosticSink.seen retains every
    // prefix forever - O(n^2) characters over a session's lifetime.
    const dedupKey = createHash("sha1").update(sortedIds.join(",")).digest("hex").slice(0, 16);
    const shown = sortedIds.slice(0, 5);
    const more = sortedIds.length > shown.length ? ` ... +${sortedIds.length - shown.length} more` : "";
    diagnostics?.report(
      "orphan-sweep",
      dedupKey,
      `swept ${swept.sweptIds.length} orphan toolResult(s): ${shown.join(", ")}${more}`,
    );
  }

  return pruned
    ? { messages: current, pruned, beforeChars: sizeMessages(messages), afterChars: sizeMessages(current) }
    : { messages, pruned, beforeChars: 0, afterChars: 0 };
}
