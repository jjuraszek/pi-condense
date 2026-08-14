import { describe, expect, test } from "bun:test";
import {
  applyChainCompressions,
  buildSyntheticChainMessage,
  isPerBatchSummaryMessage,
  perBatchSummaryOverlapsDropped,
  resolveRange,
  withoutThinkingBlocks,
} from "./chain-range-prune.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import type { ChainCompressionEntry } from "./types.js";
import { expectNoOrphanToolResults, expectZeroOrphanSweep } from "./test-support.js";


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

function summaryMsgOcc(timestamp: number, refs: { toolCallId: string; resultTimestamp: number }[]): any {
  return {
    role: "custom",
    customType: "context-prune-summary",
    content: "summary text",
    display: false,
    details: {
      toolCallRefs: refs.map((r, i) => ({ shortId: `t${i + 1}`, toolCallId: r.toolCallId, resultTimestamp: r.resultTimestamp })),
    },
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
  test("returns true when at least one legacy (no resultTimestamp) toolCallRef is in the dropped bare set", () => {
    const msg = summaryMsg(999, ["tc1", "tc2"]);
    expect(perBatchSummaryOverlapsDropped(msg, new Set(), new Set(["tc1"]))).toBe(true);
  });

  test("returns false when no legacy toolCallRefs are in the dropped bare set", () => {
    const msg = summaryMsg(999, ["tc3"]);
    expect(perBatchSummaryOverlapsDropped(msg, new Set(), new Set(["tc1", "tc2"]))).toBe(false);
  });

  test("returns false when details is missing", () => {
    const msg = { role: "custom", customType: "context-prune-summary", content: "x", timestamp: 1 };
    expect(perBatchSummaryOverlapsDropped(msg, new Set(), new Set(["tc1"]))).toBe(false);
  });

  test("an occurrence-keyed ref matches only its exact occurrence, not the bare id of a different one", () => {
    const msg = summaryMsgOcc(999, [{ toolCallId: "tc1", resultTimestamp: 3150 }]);
    // Dropped set contains a DIFFERENT occurrence of the same bare id (tc1@2000), plus the bare
    // id in the legacy fallback set — neither should cause a match for the live tc1@3150 ref.
    expect(perBatchSummaryOverlapsDropped(msg, new Set(["tc1@2000"]), new Set(["tc1"]))).toBe(false);
  });

  test("an occurrence-keyed ref matches its exact occurrence in droppedOccKeys", () => {
    const msg = summaryMsgOcc(999, [{ toolCallId: "tc1", resultTimestamp: 2000 }]);
    expect(perBatchSummaryOverlapsDropped(msg, new Set(["tc1@2000"]), new Set())).toBe(true);
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
    // Summary placed AFTER the resolved range (agent-message batching order) -
    // positionally-inside summaries are dropped unconditionally regardless of
    // coverage; coverage-based suppression only applies outside the range.
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      summaryMsg(450, ["tc2"]), // different toolCallId, outside the range
    ];
    const e = entry("b1", 100, ["tc1"], 400);
    const result = applyChainCompressions(msgs, [e], noopSummary, false);
    const hasCustomSummary = result.some(
      (m: any) => m.role === "custom" && m.customType === "context-prune-summary",
    );
    expect(hasCustomSummary).toBe(true);
  });

  test("a live turn's per-batch summary survives even when it reuses a compressed chain's bare id (occurrence collision)", () => {
    // Compressed chain drops tc1@300 (dropped range: user@100..assistant@400).
    // A later, LIVE turn reuses the bare id "tc1" with a different resultTimestamp (3150) and
    // is never dropped (outside the resolved range). Its per-batch summary references that
    // live occurrence and must not be suppressed by the earlier drop of the same bare id.
    const msgs = [
      userMsg(100),
      assistantWithTools(200, ["tc1"]),
      toolResult(300, "tc1"),
      assistantText(400),
      userMsg(3000),
      assistantWithTools(3100, ["tc1"]),
      toolResult(3150, "tc1"),
      summaryMsgOcc(3200, [{ toolCallId: "tc1", resultTimestamp: 3150 }]),
      assistantText(3300),
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
      { role: "assistant", timestamp: 9, content: [{ type: "text", text: "done" }] },
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

describe("resolveRange", () => {
  const base = () => [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "toolCall", id: "bash_1", name: "bash", input: {} }], timestamp: 1100 },
    { role: "toolResult", toolCallId: "bash_1", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1150 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1200 },
  ];
  const entry = (over: any = {}) => ({
    blockId: "b1",
    startUserTimestamp: 1000,
    droppedToolCallIds: ["bash_1"],
    droppedOccurrenceKeys: ["bash_1@1150"],
    finalAssistantTimestamp: 1200,
    toolRefs: ["t1"],
    compressedAt: 5000,
    ...over,
  });

  test("resolves the unique role-gated boundaries", () => {
    expect(resolveRange(entry(), base())).toEqual({ startIndex: 0, endIndex: 3 });
  });

  test("returns null when finalAssistantTimestamp is null", () => {
    expect(resolveRange(entry({ finalAssistantTimestamp: null }), base())).toBeNull();
  });

  test("returns null when the start timestamp matches two user messages", () => {
    const msgs = [...base(), { role: "user", content: [{ type: "text", text: "dup" }], timestamp: 1000 }];
    expect(resolveRange(entry(), msgs)).toBeNull();
  });

  test("returns null when a boundary message is absent", () => {
    expect(resolveRange(entry({ startUserTimestamp: 999 }), base())).toBeNull();
  });

  test("returns null when the end precedes the start", () => {
    // Both boundaries resolve uniquely, but the assistant match sits before
    // the user match positionally - startIndex < endIndex must still hold.
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "early" }], timestamp: 900 },
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1200 },
    ];
    expect(resolveRange(entry({ finalAssistantTimestamp: 900 }), msgs)).toBeNull();
  });

  test("ignores a toolResult sharing the final assistant timestamp (role gating)", () => {
    const msgs = base();
    msgs[2] = { ...msgs[2], timestamp: 1200 };
    expect(resolveRange(entry(), msgs)).toEqual({ startIndex: 0, endIndex: 3 });
  });

  test("resolveRange accepts a minimal timestamp pair (backfill span walk)", () => {
    const messages = [
      { role: "user", timestamp: 100 },
      { role: "assistant", timestamp: 200 },
    ];
    const range = resolveRange({ startUserTimestamp: 100, finalAssistantTimestamp: 200 }, messages);
    expect(range).toEqual({ startIndex: 0, endIndex: 1 });
  });
});

describe("applyChainCompressions - positional", () => {
  // Incident fixture: chains b5/b7 compressed, then a live turn reusing bash_23.
  const incident = () => [
    { role: "user", content: [{ type: "text", text: "1" }], timestamp: 1000 },
    { role: "assistant", content: [{ type: "toolCall", id: "bash_18", name: "bash", input: {} }], timestamp: 1100 },
    { role: "toolResult", toolCallId: "bash_18", toolName: "bash", content: [{ type: "text", text: "a" }], isError: false, timestamp: 1150 },
    { role: "assistant", content: [{ type: "text", text: "done 1" }], timestamp: 1200 },
    { role: "user", content: [{ type: "text", text: "2" }], timestamp: 2000 },
    { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 2100 },
    { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "b" }], isError: false, timestamp: 2150 },
    { role: "assistant", content: [{ type: "text", text: "done 2" }], timestamp: 2200 },
    { role: "user", content: [{ type: "text", text: "3" }], timestamp: 3000 },
    { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }, { type: "toolCall", id: "gauntlet_setting_24", name: "gauntlet_setting", input: {} }], timestamp: 3100 },
    { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 3150 },
    { role: "toolResult", toolCallId: "gauntlet_setting_24", toolName: "gauntlet_setting", content: [{ type: "text", text: "LIVE2" }], isError: false, timestamp: 3160 },
  ];
  const entries = [
    // compressedAt kept below 3000 so the "live turn" ts>=3000 filter in the
    // survives-with-both-results test below doesn't also catch the synthetics.
    { blockId: "b5", startUserTimestamp: 1000, droppedToolCallIds: ["bash_18"], droppedOccurrenceKeys: ["bash_18@1150"], finalAssistantTimestamp: 1200, toolRefs: ["t1"], compressedAt: 1050 },
    { blockId: "b7", startUserTimestamp: 2000, droppedToolCallIds: ["bash_23"], droppedOccurrenceKeys: ["bash_23@2150"], finalAssistantTimestamp: 2200, toolRefs: ["t2"], compressedAt: 2050 },
  ];
  const summaryFor = (e: any) => `summary ${e.blockId}`;

  test("the live turn reusing a dropped id survives with both of its results", () => {
    const out = applyChainCompressions(incident(), entries as any, summaryFor, false);
    const live = out.filter((m: any) => (m.timestamp ?? 0) >= 3000);
    expect(live).toHaveLength(4);
    expect(live.filter((m: any) => m.role === "toolResult").map((m: any) => m.toolCallId)).toEqual([
      "bash_23",
      "gauntlet_setting_24",
    ]);
  });

  test("drops exactly the two chain interiors and inserts both synthetics", () => {
    const out = applyChainCompressions(incident(), entries as any, summaryFor, false);
    expect(out).toHaveLength(12 - 4 + 2);
    const synthetics = out.filter((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));
    expect(synthetics).toHaveLength(2);
    expect(out.indexOf(synthetics[0])).toBe(1);
  });

  test("no toolResult survives without its toolCall", () => {
    const out = applyChainCompressions(incident(), entries as any, summaryFor, false);
    expectNoOrphanToolResults(out);
  });

  test("an unresolved entry drops nothing and inserts no synthetic", () => {
    const reports: any[] = [];
    const sink = { report: (kind: string, dedupKey: string, detail: string) => reports.push({ kind, dedupKey, detail }), counts: () => ({}) as any };
    const bad = [{ ...entries[0], finalAssistantTimestamp: null }];
    const msgs = incident();
    const out = applyChainCompressions(msgs, bad as any, summaryFor, false, undefined, sink as any);
    expect(out).toBe(msgs);
    expect(reports.map((r) => r.kind)).toEqual(["unresolved-range"]);
  });

  test("re-applying the same entries is a no-op (synthetic preserved)", () => {
    const first = applyChainCompressions(incident(), entries as any, summaryFor, false);
    const second = applyChainCompressions(first, entries as any, summaryFor, false);
    expect(second).toEqual(first);
  });

  test("a third-party custom message inside a range survives", () => {
    const msgs = incident();
    msgs.splice(2, 0, { role: "custom", customType: "other-extension", content: "keepme", timestamp: 1120 } as any);
    const out = applyChainCompressions(msgs, entries as any, summaryFor, false);
    expect(out.some((m: any) => m.customType === "other-extension")).toBe(true);
  });

  test("a per-batch summary AFTER the range is still suppressed (agent-message mode)", () => {
    const msgs = incident();
    msgs.splice(4, 0, {
      role: "custom",
      customType: CUSTOM_TYPE_SUMMARY,
      content: "batch summary",
      details: { toolCallRefs: [{ shortId: "t1", toolCallId: "bash_18", resultTimestamp: 1150 }] },
      timestamp: 1300,
    } as any);
    const out = applyChainCompressions(msgs, entries as any, summaryFor, false);
    expect(out.some((m: any) => m.customType === CUSTOM_TYPE_SUMMARY)).toBe(false);
  });

  test("strips thinking at the resolved endIndex only", () => {
    const msgs = incident();
    msgs[3] = { ...msgs[3], content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done 1" }] } as any;
    const out = applyChainCompressions(msgs, entries as any, summaryFor, true);
    const end = out.find((m: any) => m.timestamp === 1200);
    expect(end.content.some((c: any) => c.type === "thinking")).toBe(false);
  });

  test("reports range-id-mismatch when the range drops a different id set", () => {
    const reports: any[] = [];
    const sink = { report: (kind: string, dedupKey: string, detail: string) => reports.push({ kind, dedupKey, detail }), counts: () => ({}) as any };
    const skewed = [{ ...entries[0], droppedToolCallIds: ["bash_18", "ghost_1"] }];
    applyChainCompressions(incident(), skewed as any, summaryFor, false, undefined, sink as any);
    expect(reports.map((r) => r.kind)).toContain("range-id-mismatch");
  });

  test("skips an entry whose start falls strictly inside another entry's range", () => {
    // b9 opens at the user message at index 4, which sits inside a wide b8
    // range (index 0 -> 7). b8 wins; b9 contributes nothing and is reported.
    const wide = { blockId: "b8", startUserTimestamp: 1000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9002 };
    const nestedInner = { blockId: "b9", startUserTimestamp: 2000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9003 };
    const reports: any[] = [];
    const sink = { report: (kind: string, dedupKey: string, detail: string) => reports.push({ kind, dedupKey, detail }), counts: () => ({}) as any };
    const out = applyChainCompressions(incident(), [wide, nestedInner] as any, summaryFor, false, undefined, sink as any);
    const synthetics = out.filter((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));
    expect(synthetics.map((m: any) => /id="([^"]+)"/.exec(m.content[0].text)![1])).toEqual(["b8"]);
    expect(reports.filter((r) => r.kind === "unresolved-range").map((r) => r.dedupKey)).toEqual(["overlap:b9"]);
    expectNoOrphanToolResults(out);
  });

  test("a genuinely unresolvable boundary and a benign overlap skip both report unresolved-range but with distinct dedup keys", () => {
    const wide = { blockId: "b8", startUserTimestamp: 1000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9002 };
    const nestedInner = { blockId: "b9", startUserTimestamp: 2000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9003 };
    const brokenBoundary = { ...entries[0], blockId: "b11", finalAssistantTimestamp: null };
    const reports: any[] = [];
    const sink = { report: (kind: string, dedupKey: string, detail: string) => reports.push({ kind, dedupKey, detail }), counts: () => ({}) as any };
    applyChainCompressions(incident(), [wide, nestedInner, brokenBoundary] as any, summaryFor, false, undefined, sink as any);
    const kinds = reports.filter((r) => r.kind === "unresolved-range");
    const dedupKeys = kinds.map((r) => r.dedupKey).sort();
    expect(dedupKeys).toEqual(["b11", "overlap:b9"]);
    expect(new Set(dedupKeys).size).toBe(dedupKeys.length);
    const overlapReport = kinds.find((r) => r.dedupKey === "overlap:b9")!;
    const boundaryReport = kinds.find((r) => r.dedupKey === "b11")!;
    expect(overlapReport.detail).toContain("b8");
    expect(boundaryReport.detail).toContain("start=");
    expect(boundaryReport.detail).toContain("final=");
  });

  test("two entries resolving to the same startIndex insert one synthetic", () => {
    const twin = { ...entries[0], blockId: "b10", compressedAt: 9004 };
    const out = applyChainCompressions(incident(), [entries[0], twin] as any, summaryFor, false);
    const synthetics = out.filter((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));
    expect(synthetics).toHaveLength(1);
  });

  describe("G4/C3: orphan-sweep zero-fire proof", () => {
    // Runs the real orphan sweep (src/orphan-sweep.ts, backing pruner.ts Phase 4)
    // over the output of every clean applyChainCompressions fixture in this
    // describe block. None of these are expected to leave an orphan behind -
    // if one does, that is a real finding (chain-range-prune would be relying
    // on the sweep as a crutch, not producing clean output on its own).
    const fixtures: Array<[string, () => any[]]> = [
      ["the live turn reusing a dropped id survives with both of its results", () => applyChainCompressions(incident(), entries as any, summaryFor, false)],
      ["drops exactly the two chain interiors and inserts both synthetics", () => applyChainCompressions(incident(), entries as any, summaryFor, false)],
      ["re-applying the same entries is a no-op", () => applyChainCompressions(applyChainCompressions(incident(), entries as any, summaryFor, false), entries as any, summaryFor, false)],
      ["a third-party custom message inside a range survives", () => {
        const msgs = incident();
        msgs.splice(2, 0, { role: "custom", customType: "other-extension", content: "keepme", timestamp: 1120 } as any);
        return applyChainCompressions(msgs, entries as any, summaryFor, false);
      }],
      ["strips thinking at the resolved endIndex only", () => {
        const msgs = incident();
        msgs[3] = { ...msgs[3], content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done 1" }] } as any;
        return applyChainCompressions(msgs, entries as any, summaryFor, true);
      }],
      ["skips an entry whose start falls strictly inside another entry's range", () => {
        const wide = { blockId: "b8", startUserTimestamp: 1000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9002 };
        const nestedInner = { blockId: "b9", startUserTimestamp: 2000, droppedToolCallIds: [], finalAssistantTimestamp: 2200, toolRefs: [], compressedAt: 9003 };
        return applyChainCompressions(incident(), [wide, nestedInner] as any, summaryFor, false);
      }],
      ["two entries resolving to the same startIndex insert one synthetic", () => {
        const twin = { ...entries[0], blockId: "b10", compressedAt: 9004 };
        return applyChainCompressions(incident(), [entries[0], twin] as any, summaryFor, false);
      }],
      ["single dropped chain, ordering invariant fixture", () => {
        const msgs = [
          userMsg(100),
          assistantWithTools(200, ["tc1"]),
          toolResult(300, "tc1"),
          assistantText(400),
          userMsg(500),
          assistantText(600),
        ];
        return applyChainCompressions(msgs, [entry("b1", 100, ["tc1"], 400)], noopSummary, false);
      }],
      ["multiple chains in one pass", () => {
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
        return applyChainCompressions(msgs, [e1, e2], noopSummary, false);
      }],
      ["protected output relocation", () => {
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
        return applyChainCompressions(messages, [e] as any, () => "SUMMARY", false);
      }],
    ];

    for (const [name, run] of fixtures) {
      test(`zero orphan sweeps: ${name}`, () => {
        expectZeroOrphanSweep(run());
      });
    }
  });
});
