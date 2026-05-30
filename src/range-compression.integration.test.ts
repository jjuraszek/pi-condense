import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "./indexer.js";
import { BlockRefIssuer } from "./block-refs.js";
import { compressEligible } from "./chain-compressor.js";
import { pruneMessages } from "./pruner.js";
import type { ChainRange, ChainCompressionConfig } from "./types.js";

// End-to-end of the in-memory B path (everything except the LLM call, which is
// the shared runSummarization already exercised live): a span's per-batch
// summaries are fused by compressEligible, the entry lands in the real indexer's
// chain registry, and pruneMessages renders the fused text as the synthetic body.
describe("range compression integration", () => {
  test("fused range summary flows compressEligible → registry → render", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    // Two per-batch summaries covering the span's two tool calls.
    indexer.registerSummaryRefs([
      { shortId: "t1", toolCallId: "tc1" },
      { shortId: "t2", toolCallId: "tc2" },
    ]);
    indexer.registerSummaryBody(["tc1"], "summary of batch 1");
    indexer.registerSummaryBody(["tc2"], "summary of batch 2");

    const chain: ChainRange = {
      startUserTimestamp: 100,
      middleToolCallIds: ["tc1", "tc2"],
      finalAssistantTimestamp: 400,
    };

    const fuseInputs: string[] = [];
    const { compressedEntries } = await compressEligible([chain], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
      fuseRange: async (text) => {
        fuseInputs.push(text);
        return "FUSED COHESIVE SUMMARY";
      },
    });

    // Fusion received the concatenated per-batch summaries and stored its result.
    expect(fuseInputs).toEqual(["summary of batch 1\n\nsummary of batch 2"]);
    expect(compressedEntries).toHaveLength(1);
    expect(compressedEntries[0].rangeSummaryText).toBe("FUSED COHESIVE SUMMARY");
    // Entry is now in the real registry (what the renderer reads).
    expect(indexer.getChainEntries()[0].rangeSummaryText).toBe("FUSED COHESIVE SUMMARY");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "o1" }], isError: false, timestamp: 210 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: {} }], timestamp: 300, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "o2" }], isError: false, timestamp: 310 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400, usage: {}, stopReason: "end_turn" },
    ];

    const cc: ChainCompressionConfig = {
      enabled: true,
      rollingWindow: 0,
      stripFinalAssistantThinking: true,
      fuseRangeSummary: true,
    };
    const { messages: out, pruned } = pruneMessages(messages, indexer, cc);
    expect(pruned).toBe(true);

    const synthetic = out.find(
      (m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(synthetic).toBeDefined();
    // Renderer used the fused summary, not the per-batch concatenation.
    expect(synthetic.content[0].text).toContain("FUSED COHESIVE SUMMARY");
    expect(synthetic.content[0].text).not.toContain("summary of batch 1");
    expect(synthetic.content[0].text).toContain('tools="t1,t2"');

    // Middle tool turns + their results dropped; tool outputs still recoverable via the index entries (added below).
    expect(out.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
  });

  test("protected tool output is relocated into synthetic block", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    // tc1 = bash (non-protected), tc2 = todowrite (protected)
    indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "tc1" }]);
    indexer.registerSummaryBody(["tc1"], "bash output summary");

    const chain: ChainRange = {
      startUserTimestamp: 100,
      middleToolCallIds: ["tc1", "tc2"],
      finalAssistantTimestamp: 400,
      protectedToolCallIds: ["tc2"],
    };

    const { compressedEntries } = await compressEligible([chain], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
    });

    expect(compressedEntries).toHaveLength(1);
    // protectedToolCallIds round-trips through the real registry
    expect(indexer.getChainEntries()[0].protectedToolCallIds).toEqual(["tc2"]);

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "bash-result" }], isError: false, timestamp: 210 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "todowrite", arguments: {} }], timestamp: 300, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc2", toolName: "todowrite", content: [{ type: "text", text: "PLAN-STATE-XYZ" }], isError: false, timestamp: 310 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400, usage: {}, stopReason: "end_turn" },
    ];

    const cc: ChainCompressionConfig = {
      enabled: true,
      rollingWindow: 0,
      stripFinalAssistantThinking: true,
      fuseRangeSummary: false,
    };
    const { messages: out, pruned } = pruneMessages(messages, indexer, cc);
    expect(pruned).toBe(true);

    const synthetic = out.find(
      (m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(synthetic).toBeDefined();
    // Protected output is embedded in the synthetic block
    expect(synthetic.content[0].text).toContain('<protected-output tool="todowrite">');
    expect(synthetic.content[0].text).toContain("PLAN-STATE-XYZ");
    // Protected toolResult is no longer a standalone message
    expect(out.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
    // protected tool has no short ref in production → absent from the tools= attribute
    expect(synthetic.content[0].text).not.toContain("t2");
  });

  test("falls back to per-batch concat when fuseRange is absent", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();
    indexer.registerSummaryRefs([
      { shortId: "t1", toolCallId: "tc1" },
      { shortId: "t2", toolCallId: "tc2" },
    ]);
    indexer.registerSummaryBody(["tc1"], "batch one body");
    indexer.registerSummaryBody(["tc2"], "batch two body");

    const chain: ChainRange = { startUserTimestamp: 100, middleToolCallIds: ["tc1", "tc2"], finalAssistantTimestamp: 400 };
    await compressEligible([chain], 0, { indexer, blockRefs, appendEntry: () => {}, now: () => 1 });

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "o1" }], isError: false, timestamp: 210 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: {} }], timestamp: 300, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "o2" }], isError: false, timestamp: 310 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400, usage: {}, stopReason: "end_turn" },
    ];
    const cc: ChainCompressionConfig = { enabled: true, rollingWindow: 0, stripFinalAssistantThinking: true, fuseRangeSummary: false };
    const { messages: out } = pruneMessages(messages, indexer, cc);
    const synthetic = out.find((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));
    expect(synthetic.content[0].text).toContain("batch one body");
    expect(synthetic.content[0].text).toContain("batch two body");
  });
});
