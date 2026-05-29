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

function collectToolCallIds(msg: any): string[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b: any) => b.type === "toolCall" && b.id).map((b: any) => b.id as string);
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
export function detectChains(messages: any[]): ChainRange[] {
  const ranges: ChainRange[] = [];
  let state: State = "idle";
  let chainStart: { timestamp: number } | null = null;
  let middleIds = new Set<string>();

  const emitInterrupted = () => {
    if (state === "inChain" && chainStart) {
      ranges.push({
        startUserTimestamp: chainStart.timestamp,
        middleToolCallIds: [...middleIds],
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
      state = "inChain";
      continue;
    }

    if (state !== "inChain") continue;

    if (msg.role === "assistant" && hasToolCalls(msg)) {
      for (const id of collectToolCallIds(msg)) middleIds.add(id);
      continue;
    }

    if (msg.role === "toolResult") {
      if (msg.toolCallId) middleIds.add(msg.toolCallId);
      continue;
    }

    if (msg.role === "assistant" && !hasToolCalls(msg)) {
      ranges.push({
        startUserTimestamp: chainStart!.timestamp,
        middleToolCallIds: [...middleIds],
        finalAssistantTimestamp: msg.timestamp,
      });
      chainStart = null;
      middleIds = new Set();
      state = "idle";
    }
  }

  // Open chain at end of input is intentionally dropped (in-flight).

  return ranges;
}
