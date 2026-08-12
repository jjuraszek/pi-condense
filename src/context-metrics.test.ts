import { describe, expect, test } from "bun:test";
import { computeContextMetrics } from "./context-metrics.js";
import type { PruneFrontier } from "./types.js";

// ── Minimal message factories (mirrors src/chain-detector.test.ts style) ───

function userMsg(timestamp: number, text = "do the thing"): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
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

function assistantWithToolsAndThinking(timestamp: number, toolCallIds: string[], thinking = "hmm"): any {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature: "sig" },
      { type: "text", text: "working..." },
      ...toolCallIds.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
    ],
    timestamp,
    usage: {},
    stopReason: "toolUse",
  };
}

function toolResult(timestamp: number, toolCallId: string, toolName = "bash", text = "output"): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function assistantText(timestamp: number, text = "done"): any {
  return { role: "assistant", content: [{ type: "text", text }], timestamp, usage: {}, stopReason: "stop" };
}

function assistantTextWithThinking(timestamp: number, thinking = "closing thought", text = "done"): any {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature: "sig" },
      { type: "text", text },
    ],
    timestamp,
    usage: {},
    stopReason: "stop",
  };
}

const noSummarized = () => false;
const noProtected = () => false;

function fullFrontier(overrides: Partial<PruneFrontier>): PruneFrontier {
  return {
    lastAttemptedToolCallId: "tc1",
    lastAttemptedToolName: "bash",
    lastAttemptedTurnIndex: 0,
    lastAttemptedTimestamp: 0,
    attemptedBatchCount: 1,
    attemptedToolCallCount: 1,
    rawCharCount: 0,
    summaryCharCount: 0,
    outcome: "summarized",
    ...overrides,
  };
}

describe("computeContextMetrics", () => {
  test("empty branch -> all zeros", () => {
    const result = computeContextMetrics([], null, noSummarized, noProtected);
    expect(result).toEqual({ openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 });
  });

  test("open segment thinking: only counts thinking blocks strictly after the last text-only assistant", () => {
    const openThinkingBlock = { type: "thinking", thinking: "open thought that survives", thinkingSignature: "sig" };
    const msgs = [
      userMsg(100),
      assistantTextWithThinking(200, "excluded thought A"), // text-only -> excluded (at/before boundary)
      userMsg(300),
      assistantWithTools(400, ["tc1"]),
      toolResult(500, "tc1"),
      assistantTextWithThinking(600, "excluded thought B"), // new last text-only assistant
      userMsg(700),
      {
        role: "assistant",
        content: [openThinkingBlock, { type: "text", text: "working" }, { type: "toolCall", id: "tc2", name: "bash", arguments: {} }],
        timestamp: 800,
        usage: {},
        stopReason: "toolUse",
      },
      toolResult(900, "tc2"),
    ];
    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(openThinkingBlock).length / 4);
    expect(result.openCycleThinkingTokens).toBe(expected);
  });

  test("zero text-only assistants -> whole branch is the open segment", () => {
    const thinkingBlock = { type: "thinking", thinking: "the only thought", thinkingSignature: "sig" };
    const msgs = [
      userMsg(100),
      { role: "assistant", content: [thinkingBlock, { type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "toolUse" },
      toolResult(300, "tc1"),
    ];
    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.openCycleThinkingTokens).toBe(Math.round(JSON.stringify(thinkingBlock).length / 4));
  });

  test("no thinking blocks anywhere -> openCycleThinkingTokens is 0", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1"]), toolResult(300, "tc1")];
    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.openCycleThinkingTokens).toBe(0);
  });

  test("largestChainSharePct: closed chain larger than open segment -> chain dominates", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1", "bash", "x".repeat(2000)), // big closed chain
      assistantText(400),
      userMsg(500),
      assistantText(600), // tiny open segment (single text-only assistant, itself excluded from open... )
    ];
    // Recompute manually to avoid relying on the implementation under test.
    const chars = msgs.map((m) => JSON.stringify(m).length);
    const totalChars = chars.reduce((a, b) => a + b, 0);
    const chainChars = chars[0] + chars[1] + chars[2] + chars[3]; // userMsg..assistantText(400)
    const openSegmentChars = 0; // last text-only assistant is msgs[5] itself; open segment is empty (after index 5)
    const expectedPct = Math.round((100 * Math.max(chainChars, openSegmentChars)) / totalChars);

    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.largestChainSharePct).toBe(expectedPct);
    expect(chainChars).toBeGreaterThan(openSegmentChars);
  });

  test("largestChainSharePct: open segment larger than any closed chain -> open segment dominates", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"), // small closed chain
      assistantText(400), // closes chain 1
      userMsg(500),
      assistantWithTools(600, ["tc2"]),
      toolResult(700, "tc2", "bash", "y".repeat(3000)), // large open segment (never closes)
    ];
    const chars = msgs.map((m) => JSON.stringify(m).length);
    const totalChars = chars.reduce((a, b) => a + b, 0);
    const chainChars = chars[0] + chars[1] + chars[2] + chars[3];
    const openSegmentChars = chars[4] + chars[5] + chars[6];
    const expectedPct = Math.round((100 * Math.max(chainChars, openSegmentChars)) / totalChars);

    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.largestChainSharePct).toBe(expectedPct);
    expect(openSegmentChars).toBeGreaterThan(chainChars);
  });

  test("largestChainSharePct: a projected custom_message entry (role \"custom\") counts toward the denominator only, never the chain numerator", () => {
    // Mirrors index.ts's branch projection for persisted summary custom_message
    // entries: role "custom" never matches the user/assistant/toolResult roles
    // detectChains and isTextOnlyAssistant key off, so it cannot join a chain
    // or the open segment -- it only inflates totalChars (the denominator).
    // The customEntry sits between two final text-only assistant messages, so
    // it lands outside both the chain range and the open-cycle segment --
    // isolating the denominator effect from any open-segment interaction.
    const chainMsgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1", "bash", "x".repeat(2000)),
      assistantText(400),
    ];
    const customEntry = { role: "custom", customType: "pi-condense:summary", content: "s".repeat(3000), display: true, timestamp: 450 };
    const closer = assistantText(500, "ok");

    const withoutCustom = computeContextMetrics(chainMsgs, null, noSummarized, noProtected);
    const withCustom = computeContextMetrics([...chainMsgs, customEntry, closer], null, noSummarized, noProtected);

    const chainChars = chainMsgs.map((m) => JSON.stringify(m).length).reduce((a, b) => a + b, 0);
    const totalWithCustom = [...chainMsgs, customEntry, closer].map((m) => JSON.stringify(m).length).reduce((a, b) => a + b, 0);
    const expectedPctWithCustom = Math.round((100 * chainChars) / totalWithCustom);

    expect(withoutCustom.largestChainSharePct).toBe(100);
    expect(withCustom.largestChainSharePct).toBe(expectedPctWithCustom);
    expect(withCustom.largestChainSharePct).toBeLessThan(withoutCustom.largestChainSharePct);
  });

  test("largestChainSharePct: interrupted chain (null finalAssistantTimestamp) is counted", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1", "bash", "z".repeat(5000)), // huge interrupted chain
      userMsg(400), // interrupts before text-only close
      assistantText(500), // closes the second (tiny) chain
    ];
    const chars = msgs.map((m) => JSON.stringify(m).length);
    const totalChars = chars.reduce((a, b) => a + b, 0);
    const interruptedChainChars = chars[0] + chars[1] + chars[2]; // startIdx..(nextUserIdx - 1)
    const openSegmentChars = 0; // last text-only assistant is msgs[4] itself
    const expectedPct = Math.round((100 * Math.max(interruptedChainChars, openSegmentChars)) / totalChars);

    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.largestChainSharePct).toBe(expectedPct);
    expect(expectedPct).toBeGreaterThan(0);
  });

  test("largestChainSharePct: empty branch denominator is 0 -> 0 (not NaN)", () => {
    const result = computeContextMetrics([], null, noSummarized, noProtected);
    expect(result.largestChainSharePct).toBe(0);
  });

  test("frontierGapTokens: null frontier -> whole branch counted", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1", "tc2"]), toolResult(300, "tc1"), toolResult(310, "tc2")];
    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(msgs[2]).length / 4) + Math.round(JSON.stringify(msgs[3]).length / 4);
    expect(result.frontierGapTokens).toBe(expected);
  });

  test("frontierGapTokens: boundary mid-turn split excludes at-or-before calls, includes later calls in same turn", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1", "tc2"]), toolResult(300, "tc1"), toolResult(310, "tc2")];
    const frontier = fullFrontier({ lastAttemptedToolCallId: "tc1", lastAttemptedTurnIndex: 0 });
    const result = computeContextMetrics(msgs, frontier, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(msgs[3]).length / 4); // only tc2's result
    expect(result.frontierGapTokens).toBe(expected);
  });

  test("frontierGapTokens: bare-id miss (id not present in the matched turn) -> whole branch counted", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1", "tc2"]), toolResult(300, "tc1"), toolResult(310, "tc2")];
    const frontier = fullFrontier({ lastAttemptedToolCallId: "tc-does-not-exist", lastAttemptedTurnIndex: 0 });
    const result = computeContextMetrics(msgs, frontier, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(msgs[2]).length / 4) + Math.round(JSON.stringify(msgs[3]).length / 4);
    expect(result.frontierGapTokens).toBe(expected);
  });

  test("frontierGapTokens: turn index not found in branch -> whole branch counted", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1"]), toolResult(300, "tc1")];
    const frontier = fullFrontier({ lastAttemptedToolCallId: "tc1", lastAttemptedTurnIndex: 99 });
    const result = computeContextMetrics(msgs, frontier, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(msgs[2]).length / 4);
    expect(result.frontierGapTokens).toBe(expected);
  });

  test("frontierGapTokens: excludes a toolResult whose occurrence key is already summarized", () => {
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1"]), toolResult(300, "tc1")];
    const isSummarized = (key: string) => key === "tc1@300";
    const result = computeContextMetrics(msgs, null, isSummarized, noProtected);
    expect(result.frontierGapTokens).toBe(0);
  });

  test("frontierGapTokens: excludes a toolResult from a protected tool (args looked up from the pairing toolCall)", () => {
    const msgs = [
      userMsg(100),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/skills/secret.md" } }],
        timestamp: 200,
        usage: {},
        stopReason: "toolUse",
      },
      toolResult(300, "tc1", "read"),
    ];
    const isProtected = (toolName: string, args: unknown) =>
      toolName === "read" && typeof (args as any)?.path === "string" && (args as any).path.includes("/skills/");
    const result = computeContextMetrics(msgs, null, noSummarized, isProtected);
    expect(result.frontierGapTokens).toBe(0);
  });

  test("exact-value pin: frontierGapTokens equals Math.round(JSON.stringify(msg).length / 4) for a single toolResult", () => {
    const result_msg = toolResult(300, "tc1", "bash", "a fixed output payload");
    const msgs = [userMsg(100), assistantWithTools(200, ["tc1"]), result_msg];
    const result = computeContextMetrics(msgs, null, noSummarized, noProtected);
    expect(result.frontierGapTokens).toBe(Math.round(JSON.stringify(result_msg).length / 4));
  });

  test("frontierGapTokens: a toolCall id reused in a LATER turn (past the boundary) still counts its result — exclusion is positional, not id-global", () => {
    const laterResult = toolResult(700, "tc1", "bash", "y".repeat(196)); // ~49 tokens
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]), // turn 0 — this is the boundary turn
      toolResult(300, "tc1"), // boundary result — correctly excluded
      assistantText(400), // closes turn 0's chain
      userMsg(500),
      assistantWithTools(600, ["tc1"]), // turn 1 — reuses bare id "tc1" (legal: ids are only unique per turn)
      laterResult, // must be counted: it is positionally after the boundary
    ];
    const frontier = fullFrontier({ lastAttemptedToolCallId: "tc1", lastAttemptedTurnIndex: 0 });
    const result = computeContextMetrics(msgs, frontier, noSummarized, noProtected);
    const expected = Math.round(JSON.stringify(laterResult).length / 4);
    expect(result.frontierGapTokens).toBe(expected);
  });

  test("frontierGapTokens: args pairing for a reused id uses the nearest preceding assistant's toolCall, not a global id map", () => {
    const msgs = [
      userMsg(100),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/normal.md" } }],
        timestamp: 200,
        usage: {},
        stopReason: "toolUse",
      }, // turn 0 — unprotected args
      toolResult(300, "tc1", "read"),
      assistantText(400),
      userMsg(500),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/skills/secret.md" } }],
        timestamp: 600,
        usage: {},
        stopReason: "toolUse",
      }, // turn 1 — reuses bare id "tc1" with protected args
      toolResult(700, "tc1", "read"),
    ];
    const isProtected = (toolName: string, args: unknown) =>
      toolName === "read" && typeof (args as any)?.path === "string" && (args as any).path.includes("/skills/");
    const result = computeContextMetrics(msgs, null, noSummarized, isProtected);
    // turn 0's result (unprotected args) counts; turn 1's result (protected args) is excluded.
    const expected = Math.round(JSON.stringify(msgs[2]).length / 4);
    expect(result.frontierGapTokens).toBe(expected);
  });
});
