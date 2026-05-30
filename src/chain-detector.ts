import type { ChainRange } from "./types.js";

/** Prefix that identifies a synthetic chain-compression user message. */
const COMPRESSED_CHAIN_PREFIX = "<compressed-chain";

function isSyntheticChainMessage(msg: any): boolean {
  const content = msg.content;
  if (typeof content === "string") return content.trimStart().startsWith(COMPRESSED_CHAIN_PREFIX);
  if (!Array.isArray(content)) return false;
  const first = content[0];
  return first?.type === "text" && typeof first.text === "string" && first.text.trimStart().startsWith(COMPRESSED_CHAIN_PREFIX);
}

function hasToolCalls(msg: any): boolean {
  return Array.isArray(msg.content) && msg.content.some((b: any) => b.type === "toolCall");
}

function collectToolCalls(msg: any): { id: string; name: string }[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b: any) => b.type === "toolCall" && b.id && b.name)
    .map((b: any) => ({ id: b.id as string, name: b.name as string }));
}

type State = "idle" | "inChain";

/**
 * Walks an AgentMessage array and emits ChainRange records for each detectable chain.
 *
 * A chain is: [user message] → [assistant+toolResult turns...] → [text-only assistant].
 * Synthetic chain messages (injected by chain-range-prune) are treated as passthroughs —
 * not chain starts. This is defensive; the detector normally runs pre-compression.
 *
 * NOTE: Message identity uses `timestamp` (for user / final text-only assistant) and
 * `toolCallId` sets (for middle tool-using turns). AgentMessage has no `.id` field.
 */
export function detectChains(messages: any[], protectedTools: string[] = []): ChainRange[] {
  const ranges: ChainRange[] = [];
  const protectedSet = new Set(protectedTools);
  let state: State = "idle";
  let chainStart: { timestamp: number } | null = null;
  let middleIds = new Set<string>();
  let protectedIds = new Set<string>();

  const emitInterrupted = () => {
    if (state === "inChain" && chainStart) {
      ranges.push({
        startUserTimestamp: chainStart.timestamp,
        middleToolCallIds: [...middleIds],
        protectedToolCallIds: [...protectedIds],
        finalAssistantTimestamp: null,
      });
    }
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      if (isSyntheticChainMessage(msg)) continue; // passthrough — not a chain start
      emitInterrupted();
      chainStart = { timestamp: msg.timestamp };
      middleIds = new Set();
      protectedIds = new Set();
      state = "inChain";
      continue;
    }

    if (state !== "inChain") continue;

    if (msg.role === "assistant" && hasToolCalls(msg)) {
      for (const { id, name } of collectToolCalls(msg)) {
        middleIds.add(id);
        if (protectedSet.has(name)) protectedIds.add(id);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      if (msg.toolCallId) {
        middleIds.add(msg.toolCallId);
        if (protectedSet.has(msg.toolName)) protectedIds.add(msg.toolCallId);
      }
      continue;
    }

    if (msg.role === "assistant" && !hasToolCalls(msg)) {
      ranges.push({
        startUserTimestamp: chainStart!.timestamp,
        middleToolCallIds: [...middleIds],
        protectedToolCallIds: [...protectedIds],
        finalAssistantTimestamp: msg.timestamp,
      });
      chainStart = null;
      middleIds = new Set();
      protectedIds = new Set();
      state = "idle";
    }
  }

  // Open chain at end of input is intentionally dropped (in-flight).

  return ranges;
}

/**
 * Appends `closing` to a copy of `branchMessages` unless the array already ends with it.
 *
 * pi emits `message_end` to extensions BEFORE persisting the message to the session
 * (agent-session.js `_processAgentEvent` runs `_emitExtensionEvent` ahead of
 * `sessionManager.appendMessage`). At the agent-message flush boundary the just-closed
 * final assistant is therefore still missing from `getBranch()`; without threading it
 * in, the newest chain reads as open and the rolling window over-retains by one
 * (effective K+1 instead of K). Identity is role+timestamp (AgentMessage has no id,
 * matching the detector's own identity model), so a future pi that persists before
 * emitting keeps this a no-op.
 */
export function withClosingMessage(branchMessages: any[], closing: any): any[] {
  if (!closing) return branchMessages;
  const last = branchMessages[branchMessages.length - 1];
  if (last && last.role === closing.role && last.timestamp === closing.timestamp) return branchMessages;
  return [...branchMessages, closing];
}
