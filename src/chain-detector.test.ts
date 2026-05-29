import { describe, expect, test } from "bun:test";
import { detectChains } from "./chain-detector.js";

// ── Minimal message factories ──────────────────────────────────────────────

function userMsg(timestamp: number, text = "do the thing"): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function syntheticChainMsg(timestamp: number, blockId = "b1"): any {
  return {
    role: "user",
    content: [{ type: "text", text: `<compressed-chain id="${blockId}" tools="t1">summary</compressed-chain>` }],
    timestamp,
  };
}

function assistantWithTools(timestamp: number, toolCallIds: string[]): any {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "working..." },
      ...toolCallIds.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
    ],
    timestamp,
    usage: {},
    stopReason: "toolUse",
  };
}

function toolResult(timestamp: number, toolCallId: string): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "output" }],
    isError: false,
    timestamp,
  };
}

function assistantText(timestamp: number, text = "done"): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }, { type: "thinking", thinking: "thoughts", thinkingSignature: "sig" }],
    timestamp,
    usage: {},
    stopReason: "stop",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("detectChains", () => {
  test("empty input returns empty array", () => {
    expect(detectChains([])).toEqual([]);
  });

  test("single complete chain produces one range", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1", "tc2"]),
      toolResult(300, "tc1"),
      toolResult(310, "tc2"),
      assistantText(400),
    ];
    const ranges = detectChains(msgs);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startUserTimestamp).toBe(100);
    expect(ranges[0].middleToolCallIds).toContain("tc1");
    expect(ranges[0].middleToolCallIds).toContain("tc2");
    expect(ranges[0].finalAssistantTimestamp).toBe(400);
  });

  test("multi-chain sequence produces N ranges in order", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(500),
      assistantWithTools(600, ["tc2"]),
      toolResult(700, "tc2"),
      assistantText(800),
    ];
    const ranges = detectChains(msgs);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startUserTimestamp).toBe(100);
    expect(ranges[0].finalAssistantTimestamp).toBe(400);
    expect(ranges[1].startUserTimestamp).toBe(500);
    expect(ranges[1].finalAssistantTimestamp).toBe(800);
  });

  test("open chain (no text-only close) is not emitted", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      // no text-only assistant close
    ];
    expect(detectChains(msgs)).toHaveLength(0);
  });

  test("synthetic chain message is not treated as a chain start", () => {
    const msgs = [
      syntheticChainMsg(50),   // should be skipped
      assistantText(200),       // text-only but no prior real chain start
    ];
    expect(detectChains(msgs)).toHaveLength(0);
  });

  test("synthetic chain message in a real multi-chain sequence is a passthrough", () => {
    // Represents a session after one chain was already compressed:
    // synthetic summary, then the next real chain
    const msgs = [
      syntheticChainMsg(50),
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const ranges = detectChains(msgs);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startUserTimestamp).toBe(100);
  });

  test("interrupted chain (user interrupts before text-only close) emits with null final", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      userMsg(400), // second user message interrupts before chain close
      assistantText(500),
    ];
    const ranges = detectChains(msgs);
    // First chain is interrupted → emitted with null finalAssistantTimestamp
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startUserTimestamp).toBe(100);
    expect(ranges[0].finalAssistantTimestamp).toBeNull();
    // Second "chain" opened at ts=400, but text-only at 500 closes it (no tool calls needed)
    // Actually, the second user at 400 starts a chain, but its assistant turn has no toolCalls
    // so middleToolCallIds is empty and it immediately closes with the text-only assistant.
    expect(ranges[1].startUserTimestamp).toBe(400);
    expect(ranges[1].middleToolCallIds).toEqual([]);
    expect(ranges[1].finalAssistantTimestamp).toBe(500);
  });

  test("middleToolCallIds contains all toolCallIds from assistant and toolResult messages", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1", "tc2"]),
      toolResult(300, "tc1"),
      toolResult(310, "tc2"),
      assistantWithTools(400, ["tc3"]),
      toolResult(500, "tc3"),
      assistantText(600),
    ];
    const [range] = detectChains(msgs);
    expect(range.middleToolCallIds.sort()).toEqual(["tc1", "tc2", "tc3"].sort());
  });
});
