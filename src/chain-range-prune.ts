import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import type { ChainCompressionEntry } from "./types.js";
import { substituteBlockRefs } from "./nested-placeholders.js";
import { extractToolResultText } from "./batch-capture.js";

export function isPerBatchSummaryMessage(msg: any): boolean {
  return msg.role === "custom" && msg.customType === CUSTOM_TYPE_SUMMARY;
}

export function perBatchSummaryOverlapsDropped(msg: any, droppedSet: Set<string>): boolean {
  const refs: { toolCallId: string }[] = msg.details?.toolCallRefs ?? [];
  return refs.some((r) => droppedSet.has(r.toolCallId));
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

export function applyChainCompressions(
  messages: any[],
  chainEntries: ChainCompressionEntry[],
  summaryTextForChain: (entry: ChainCompressionEntry) => string,
  stripFinalThinking: boolean,
  blockSummaryLookup?: (blockId: string) => string | undefined,
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

  const droppedToolCallIds = new Set<string>();
  const stripFinalAtTimestamp = new Set<number>();

  const protectedIdToBlock = new Map<string, string>();
  for (const e of chainEntries) {
    for (const id of e.droppedToolCallIds) droppedToolCallIds.add(id);
    for (const id of e.protectedToolCallIds ?? []) protectedIdToBlock.set(id, e.blockId);
    if (e.finalAssistantTimestamp !== null && stripFinalThinking) {
      stripFinalAtTimestamp.add(e.finalAssistantTimestamp);
    }
  }

  const protectedByBlock = new Map<string, { tool: string; text: string }[]>();
  if (protectedIdToBlock.size > 0) {
    for (const msg of messages) {
      if (msg.role === "toolResult" && protectedIdToBlock.has(msg.toolCallId)) {
        const blockId = protectedIdToBlock.get(msg.toolCallId)!;
        const arr = protectedByBlock.get(blockId) ?? [];
        arr.push({ tool: msg.toolName, text: extractToolResultText(msg) });
        protectedByBlock.set(blockId, arr);
      }
    }
  }

  const insertAfterUserTimestamp = new Map<number, { synthetic: any; blockId: string }>();
  for (const e of chainEntries) {
    // Each ChainCompressionEntry has a distinct startUserTimestamp — enforced by chain-compressor at the orchestration layer.
    insertAfterUserTimestamp.set(e.startUserTimestamp, {
      synthetic: buildSyntheticChainMessage(e, summaryTextForChain(e), blockSummaryLookup, protectedByBlock.get(e.blockId) ?? []),
      blockId: e.blockId,
    });
  }

  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === "toolResult" && droppedToolCallIds.has(msg.toolCallId)) continue;

    if (msg.role === "assistant") {
      const callIds: string[] = (msg.content ?? [])
        .filter((c: any) => c.type === "toolCall")
        .map((c: any) => c.id as string);
      if (callIds.some((id) => droppedToolCallIds.has(id))) continue;
      if (stripFinalAtTimestamp.has(msg.timestamp)) {
        out.push(withoutThinkingBlocks(msg));
        continue;
      }
    }

    if (isPerBatchSummaryMessage(msg) && perBatchSummaryOverlapsDropped(msg, droppedToolCallIds)) continue;

    out.push(msg);

    if (msg.role === "user") {
      const info = insertAfterUserTimestamp.get(msg.timestamp);
      if (info && !existingSyntheticBlockIds.has(info.blockId)) {
        out.push(info.synthetic);
      }
    }
  }
  return out;
}
