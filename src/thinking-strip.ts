import { withoutThinkingBlocks } from "./chain-range-prune.js";
import type { ThinkingStripConfig } from "./types.js";

/**
 * Rolling main-loop thinking strip.
 *
 * Keeps `thinking` blocks on the last `keepLastTurns` assistant turns and
 * strips them from all older assistant messages, preserving each message's
 * `text` and `toolCall` blocks. "Turn" counts ASSISTANT messages, not
 * user-bounded spans — the target failure mode is a single long open chain
 * (zero subagents, near-zero user turns) where a span-based window keeps
 * everything.
 *
 * Provider safety (Anthropic): during tool use only the LAST assistant turn's
 * thinking is required; prior turns may be omitted, and a message's thinking
 * blocks must be dropped all-or-nothing. `keepLastTurns` is clamped to >= 1 so
 * the most-recent assistant turn always keeps its thinking. Stripping reuses
 * `withoutThinkingBlocks` (drops the whole block incl. signature).
 *
 * Returns the original array reference unchanged when nothing is stripped, so
 * `pruneMessages` can skip reconstruction.
 */
export function stripOldThinking(messages: any[], config: ThinkingStripConfig): any[] {
  if (!config.enabled) return messages;
  const keep = Math.max(1, config.keepLastTurns);

  const assistantIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") assistantIdx.push(i);
  }
  if (assistantIdx.length <= keep) return messages;

  const firstKeptAssistant = assistantIdx[assistantIdx.length - keep];
  let changed = false;
  const out = messages.map((msg, i) => {
    if (i >= firstKeptAssistant || msg?.role !== "assistant") return msg;
    if (!Array.isArray(msg.content) || !msg.content.some((c: any) => c.type === "thinking")) return msg;
    changed = true;
    return withoutThinkingBlocks(msg);
  });
  return changed ? out : messages;
}
