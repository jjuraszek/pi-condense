import { describe, expect, test } from "bun:test";
import {
  applyChainCompressions,
  buildSyntheticChainMessage,
  isPerBatchSummaryMessage,
  perBatchSummaryOverlapsDropped,
  withoutThinkingBlocks,
} from "./chain-range-prune.js";
import type { ChainCompressionEntry } from "./types.js";


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

function assistantText(timestamp: number, includeThinking = false): any {
  const content: any[] = [{ type: "text", text: "done" }];
  if (includeThinking) {
    content.push({ type: "thinking", thinking: "deep thoughts", thinkingSignature: "sig123" });
  }
  return { role: "assistant", content, timestamp, usage: {}, stopReason: "stop" };
}

function summaryMsg(timestamp: number, toolCallIds: string[]): any {
  return {
    role: "custom",
    customType: "context-prune-summary",
    content: "summary text",
    display: false,
    details: { toolCallRefs: toolCallIds.map((id, i) => ({ shortId: `t${i + 1}`, toolCallId: id })) },
    timestamp,
  };
}

function entry(
  blockId: string,
  startUserTimestamp: number,
  droppedToolCallIds: string[],
  finalAssistantTimestamp: number | null,
  toolRefs: string[] = [],
): ChainCompressionEntry {
  return {
    blockId,
    startUserTimestamp,
    droppedToolCallIds,
    finalAssistantTimestamp,
    toolRefs,
    compressedAt: startUserTimestamp + 9999,
  };
}

const noopSummary = (_e: ChainCompressionEntry) => "chain summary";

describe("isPerBatchSummaryMessage", () => {
  test("returns true for context-prune-summary custom message", () => {
    expect(isPerBatchSummaryMessage({ role: "custom", customType: "context-prune-summary" })).toBe(true);
  });

  test("returns false for other custom messages", () => {
    expect(isPerBatchSummaryMessage({ role: "custom", customType: "context-prune-index" })).toBe(false);
  });

  test("returns false for user/assistant/toolResult roles", () => {
    expect(isPerBatchSummaryMessage({ role: "user" })).toBe(false);
    expect(isPerBatchSummaryMessage({ role: "assistant" })).toBe(false);
    expect(isPerBatchSummaryMessage({ role: "toolResult" })).toBe(false);
  });
});

describe("perBatchSummaryOverlapsDropped", () => {
  test("returns true when at least one toolCallRef is in the dropped set", () => {
    const msg = summaryMsg(999, ["tc1", "tc2"]);
    expect(perBatchSummaryOverlapsDropped(msg, new Set(["tc1"]))).toBe(true);
  });

  test("returns false when no toolCallRefs are in the dropped set", () => {
    const msg = summaryMsg(999, ["tc3"]);
    expect(perBatchSummaryOverlapsDropped(msg, new Set(["tc1", "tc2"]))).toBe(false);
  });

  test("returns false when details is missing", () => {
    const msg = { role: "custom", customType: "context-prune-summary", content: "x", timestamp: 1 };
    expect(perBatchSummaryOverlapsDropped(msg, new Set(["tc1"]))).toBe(false);
  });
});

describe("withoutThinkingBlocks", () => {
  test("removes thinking blocks, keeps text blocks", () => {
    const msg = assistantText(100, true);
    const result = withoutThinkingBlocks(msg);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  test("returns copy, not mutation", () => {
    const msg = assistantText(100, true);
    const result = withoutThinkingBlocks(msg);
    expect(result).not.toBe(msg);
    expect(msg.content).toHaveLength(2); // original unchanged
  });

  test("no-op when no thinking blocks present", () => {
    const msg = assistantText(100, false);
    const result = withoutThinkingBlocks(msg);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});

describe("buildSyntheticChainMessage", () => {
  test("produces a user-role message with F2 XML wrapper", () => {
    const e = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const msg = buildSyntheticChainMessage(e, "the summary");
    expect(msg.role).toBe("user");
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toContain(`id="b1"`);
    expect(msg.content[0].text).toContain(`tools="t1"`);
    expect(msg.content[0].text).toContain("the summary");
  });

  test("uses compressedAt as timestamp", () => {
    const e = entry("b1", 100, ["tc1"], 400);
    const msg = buildSyntheticChainMessage(e, "summary");
    expect(msg.timestamp).toBe(e.compressedAt);
  });

  test("multiple toolRefs are comma-joined", () => {
    const e = entry("b2", 200, ["tc1", "tc2"], 500, ["t1", "t2"]);
    const msg = buildSyntheticChainMessage(e, "summary");
    expect(msg.content[0].text).toContain(`tools="t1,t2"`);
  });
});

describe("applyChainCompressions", () => {
  test("no-op when chainEntries is empty", () => {
    const msgs = [userMsg(100), assistantText(200)];
    const result = applyChainCompressions(msgs, [], noopSummary, true);
    expect(result).toBe(msgs); // same reference
  });

  test("drops ToolResultMessage whose toolCallId is in droppedToolCallIds", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    const roles = result.map((m: any) => m.role);
    expect(roles).not.toContain("toolResult");
  });

  test("drops AssistantMessage whose ToolCall blocks include a dropped id", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    // Only the final text-only assistant should remain (the one at 400)
    const assistants = result.filter((m: any) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].timestamp).toBe(400);
  });

  test("inserts synthetic chain message immediately after the start user message", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);

    const userIdx = result.findIndex((m: any) => m.role === "user" && m.timestamp === 100);
    expect(userIdx).not.toBe(-1);
    const nextMsg = result[userIdx + 1];
    expect(nextMsg.role).toBe("user");
    expect(nextMsg.content[0].text).toContain("compressed-chain");
  });

  test("ordering invariant: output preserves input order for surviving messages", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(500),
      assistantText(600),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);

    // Timestamps of remaining real messages should be in ascending order
    const timestamps = result
      .filter((m: any) => !(m.content?.[0]?.text ?? "").includes("compressed-chain"))
      .map((m: any) => m.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  test("suppresses per-batch summary whose toolCallRefs overlap droppedToolCallIds", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      summaryMsg(350, ["tc1"]),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    const hasCustomSummary = result.some(
      (m: any) => m.role === "custom" && m.customType === "context-prune-summary",
    );
    expect(hasCustomSummary).toBe(false);
  });

  test("does not suppress per-batch summary whose toolCallRefs do not overlap", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      summaryMsg(350, ["tc2"]), // different toolCallId
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    const hasCustomSummary = result.some(
      (m: any) => m.role === "custom" && m.customType === "context-prune-summary",
    );
    expect(hasCustomSummary).toBe(true);
  });

  test("strips thinking blocks from final assistant when stripFinalThinking=true", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400, true), // has thinking block
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, true);
    const finalAssistant = result.find((m: any) => m.role === "assistant" && m.timestamp === 400);
    expect(finalAssistant).toBeDefined();
    expect(finalAssistant.content.some((c: any) => c.type === "thinking")).toBe(false);
    expect(finalAssistant.content.some((c: any) => c.type === "text")).toBe(true);
  });

  test("keeps thinking blocks on final assistant when stripFinalThinking=false", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400, true),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    const finalAssistant = result.find((m: any) => m.role === "assistant" && m.timestamp === 400);
    expect(finalAssistant.content.some((c: any) => c.type === "thinking")).toBe(true);
  });

  test("idempotency: calling twice with same chainEntries yields same output", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(500),
      assistantText(600),
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const first = applyChainCompressions(msgs, [e], noopSummary, true);
    const second = applyChainCompressions(first, [e], noopSummary, true);
    expect(second).toEqual(first);
  });

  test("idempotency: stable with blockSummaryLookup active", () => {
    // Exercises the substitution code path across two passes.
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(500),
      assistantText(600),
    ];
    const e = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const summaryFn = (_: ChainCompressionEntry) => "chain summary text";
    const blockLookup = (id: string) => (id === "b1" ? "chain summary text" : undefined);
    const first = applyChainCompressions(msgs, [e], summaryFn, false, blockLookup);
    const second = applyChainCompressions(first, [e], summaryFn, false, blockLookup);
    expect(second).toEqual(first);
  });

  test("multiple chains in one pass: each behaves independently", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(500),
      assistantWithTools(600, ["tc2"]),
      toolResult(700, "tc2"),
      assistantText(800),
      userMsg(900),
      assistantText(1000),
    ];
    const e1 = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const e2 = entry("b2", 500, ["tc2"], 800, ["t2"]);
    const result = applyChainCompressions(msgs, [e1, e2], noopSummary, false);

    // Both toolResult messages should be gone
    const toolResults = result.filter((m: any) => m.role === "toolResult");
    expect(toolResults).toHaveLength(0);

    // Both synthetic chain messages should be present
    const synthetics = result.filter(
      (m: any) => (m.content?.[0]?.text ?? "").includes("compressed-chain"),
    );
    expect(synthetics).toHaveLength(2);
    expect(synthetics[0].content[0].text).toContain(`id="b1"`);
    expect(synthetics[1].content[0].text).toContain(`id="b2"`);

    // The uncompressed chain (userMsg 900 + assistantText 1000) should survive intact
    expect(result.some((m: any) => m.role === "user" && m.timestamp === 900)).toBe(true);
    expect(result.some((m: any) => m.role === "assistant" && m.timestamp === 1000)).toBe(true);
  });

  test("summaryTextForChain callback receives the correct entry", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const capturedEntries: ChainCompressionEntry[] = [];
    const summary = (entry: ChainCompressionEntry) => {
      capturedEntries.push(entry);
      return "custom summary for " + entry.blockId;
    };
    const result = applyChainCompressions(msgs, [e], summary, false);
    expect(capturedEntries).toHaveLength(1);
    expect(capturedEntries[0].blockId).toBe("b1");
    const synthetic = result.find((m: any) => (m.content?.[0]?.text ?? "").includes("compressed-chain"));
    expect(synthetic?.content[0].text).toContain("custom summary for b1");
  });

  test("blockSummaryLookup: {bN} in summary text is substituted", () => {
    // Two chains: b1 (startUser=100) and b2 (startUser=500).
    // b2's summary references {b1}. With a lookup, {b1} should be replaced inline.
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
    const e1 = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const e2 = entry("b2", 500, ["tc2"], 800, ["t2"]);
    const b1SummaryText = "b1 summary text";
    const summaryLookup = (entry: ChainCompressionEntry) =>
      entry.blockId === "b1" ? b1SummaryText : "see {b1} for details";
    const blockLookup = (blockId: string) =>
      blockId === "b1" ? b1SummaryText : undefined;
    const result = applyChainCompressions(msgs, [e1, e2], summaryLookup, false, blockLookup);
    const b2Synthetic = result.find(
      (m: any) => (m.content?.[0]?.text ?? "").includes('id="b2"'),
    );
    // {b1} inside b2's summary should be expanded
    expect(b2Synthetic?.content[0].text).toContain(`see ${b1SummaryText} for details`);
    expect(b2Synthetic?.content[0].text).not.toContain("{b1}");
    // b1's own synthetic should not be affected
    const b1Synthetic = result.find(
      (m: any) => (m.content?.[0]?.text ?? "").includes('id="b1"'),
    );
    expect(b1Synthetic?.content[0].text).toContain(b1SummaryText);
  });

  test("relocates protected output verbatim into the compressed-chain body and still drops it from position", () => {
    const e = {
      blockId: "b1",
      startUserTimestamp: 1,
      droppedToolCallIds: ["tc-read", "tc-todo"],
      protectedToolCallIds: ["tc-todo"],
      finalAssistantTimestamp: 9,
      toolRefs: ["t1", "t2"],
      compressedAt: 100,
    };
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "go" }] },
      { role: "assistant", timestamp: 2, content: [
        { type: "toolCall", id: "tc-read", name: "read" },
        { type: "toolCall", id: "tc-todo", name: "todowrite" },
      ] },
      { role: "toolResult", toolCallId: "tc-read", toolName: "read", content: [{ type: "text", text: "FILE" }] },
      { role: "toolResult", toolCallId: "tc-todo", toolName: "todowrite", content: [{ type: "text", text: "PLAN-STATE" }] },
      { role: "assistant", timestamp: 9, content: [{ type: "text", text: "done" }] },
    ];
    const out = applyChainCompressions(messages, [e] as any, () => "SUMMARY", false);
    // protected toolResult dropped from original position
    expect(out.find((m: any) => m.role === "toolResult" && m.toolCallId === "tc-todo")).toBeUndefined();
    // text relocated into the synthetic block, under a labeled tag
    const synthetic = out.find((m: any) => typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"));
    expect(synthetic.content[0].text).toContain('<protected-output tool="todowrite">');
    expect(synthetic.content[0].text).toContain("PLAN-STATE");
    // non-protected output is NOT relocated
    expect(synthetic.content[0].text).not.toContain("FILE");
  });

  test("renders byte-identical to pre-feature output when no protected ids", () => {
    const e = {
      blockId: "b1", startUserTimestamp: 1, droppedToolCallIds: ["tc-read"],
      finalAssistantTimestamp: 9, toolRefs: ["t1"], compressedAt: 100,
    };
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "go" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "tc-read", name: "read" }] },
      { role: "toolResult", toolCallId: "tc-read", toolName: "read", content: [{ type: "text", text: "FILE" }] },
      { role: "assistant", timestamp: 9, content: [{ type: "text", text: "done" }] },
    ];
    const out = applyChainCompressions(messages, [e] as any, () => "SUMMARY", false);
    const synthetic = out.find((m: any) => typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"));
    expect(synthetic.content[0].text).toBe('<compressed-chain id="b1" tools="t1">\nSUMMARY\n</compressed-chain>');
  });

  test("relocates multiple protected outputs in message order within one block", () => {
    const e = {
      blockId: "b1",
      startUserTimestamp: 1,
      droppedToolCallIds: ["tc-a", "tc-b"],
      protectedToolCallIds: ["tc-a", "tc-b"],
      finalAssistantTimestamp: 9,
      toolRefs: ["t1", "t2"],
      compressedAt: 100,
    };
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "go" }] },
      { role: "assistant", timestamp: 2, content: [
        { type: "toolCall", id: "tc-a", name: "todowrite" },
        { type: "toolCall", id: "tc-b", name: "todoread" },
      ] },
      { role: "toolResult", toolCallId: "tc-a", toolName: "todowrite", content: [{ type: "text", text: "FIRST" }] },
      { role: "toolResult", toolCallId: "tc-b", toolName: "todoread", content: [{ type: "text", text: "SECOND" }] },
      { role: "assistant", timestamp: 9, content: [{ type: "text", text: "done" }] },
    ];
    const out = applyChainCompressions(messages, [e] as any, () => "SUMMARY", false);
    const synthetic = out.find((m: any) => typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"));
    const text = synthetic.content[0].text as string;
    expect(text).toContain('<protected-output tool="todowrite">\nFIRST\n</protected-output>');
    expect(text).toContain('<protected-output tool="todoread">\nSECOND\n</protected-output>');
    expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
  });

  test("skips a protected id whose toolResult is absent from input", () => {
    const e = {
      blockId: "b1",
      startUserTimestamp: 1,
      droppedToolCallIds: ["tc-gone"],
      protectedToolCallIds: ["tc-gone"],
      finalAssistantTimestamp: 9,
      toolRefs: ["t1"],
      compressedAt: 100,
    };
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "go" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "done" }] },
    ];
    const out = applyChainCompressions(messages, [e] as any, () => "SUMMARY", false);
    const synthetic = out.find((m: any) => typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"));
    expect(synthetic).toBeDefined();
    expect(synthetic.content[0].text).not.toContain("<protected-output");
  });

  test("blockSummaryLookup: missing lookup leaves placeholder literal", () => {
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
    ];
    const e = entry("b1", 100, ["tc1"], 400, ["t1"]);
    const summaryFn = () => "refers to {b99} unknown";
    const blockLookup = (_: string) => undefined;
    const result = applyChainCompressions(msgs, [e], summaryFn, false, blockLookup);
    const synthetic = result.find((m: any) => (m.content?.[0]?.text ?? "").includes("compressed-chain"));
    // {b99} unknown block stays as literal
    expect(synthetic?.content[0].text).toContain("{b99}");
  });
});
