import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "./indexer.js";
import { BlockRefIssuer } from "./block-refs.js";
import { compressEligible } from "./chain-compressor.js";
import { pruneMessages } from "./pruner.js";
import { detectChains } from "./chain-detector.js";
import { isProtected } from "./protected.js";
import { bareToolCallId, occKey } from "./occurrence-key.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_INDEX } from "./types.js";
import type { ChainRange, ChainCompressionConfig } from "./types.js";

const noopDiagnostics = { report: () => {} };
const testBackfill = { spillThreshold: 1_000_000, spillPreviewBytes: 2048, sessionDir: "/tmp", sessionId: "s1" };

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
      messages: [],
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
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
      messages: [],
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
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

  test("path-protected output is relocated via detectChains predicate", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    // tc1 = read /h/src/app.ts (unprotected), tc2 = read /h/skills/x/SKILL.md (protected)
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", input: { path: "/h/src/app.ts" } }],
        timestamp: 200,
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "app-source-code" }],
        isError: false,
        timestamp: 210,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "read", input: { path: "/h/skills/x/SKILL.md" } }],
        timestamp: 300,
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "read",
        content: [{ type: "text", text: "SKILL-VERBATIM-CONTENT" }],
        isError: false,
        timestamp: 310,
      },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400, usage: {}, stopReason: "end_turn" },
    ];

    const pred = (name: string, args: unknown) =>
      isProtected(name, args, { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] });
    const chains = detectChains(messages, pred);

    expect(chains).toHaveLength(1);
    expect(chains[0].protectedToolCallIds).toEqual(["tc2"]);

    // Only unprotected tc1 has a per-batch summary; tc2 is protected, no short ref.
    // Keyed by the occurrence key detectChains actually produced for tc1's result
    // (id + resultTimestamp), not the bare toolCallId, so this can't silently drift.
    const tc1OccKey = chains[0].middleOccurrenceKeys!.find((k) => bareToolCallId(k) === "tc1")!;
    expect(tc1OccKey).toBeDefined();
    indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "tc1" }]);
    indexer.registerSummaryBody([tc1OccKey], "read app.ts summary");

    const { compressedEntries } = await compressEligible(chains, 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(1);
    expect(indexer.getChainEntries()[0].protectedToolCallIds).toEqual(["tc2"]);

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
    // Protected SKILL.md output is embedded verbatim
    expect(synthetic.content[0].text).toContain('<protected-output tool="read">');
    expect(synthetic.content[0].text).toContain("SKILL-VERBATIM-CONTENT");
    // Unprotected result text is not present in the synthetic block
    expect(synthetic.content[0].text).not.toContain("app-source-code");
    // No standalone toolResult messages remain
    expect(out.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
    // Protected tc2 has no short ref → absent from the tools= attribute
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
    await compressEligible([chain], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 1,
      messages: [],
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

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

  test("mixed flush: one covered + one uncovered chain compress in a single compressEligible call", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    // Chain A (covered): per-batch summary exists for tcA.
    indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "tcA" }]);
    indexer.registerSummaryBody(["tcA"], "summary of tcA");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go A" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcA", name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcA", toolName: "bash", content: [{ type: "text", text: "outA" }], isError: false, timestamp: 210 },
      { role: "assistant", content: [{ type: "text", text: "done A" }], timestamp: 400, usage: {}, stopReason: "end_turn" },
      // Chain B (uncovered): no per-batch summary for tcB1/tcB2.
      { role: "user", content: [{ type: "text", text: "go B" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB1", name: "bash", arguments: { cmd: "one" } }], timestamp: 1100, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB1", toolName: "bash", content: [{ type: "text", text: "outB1" }], isError: false, timestamp: 1110 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB2", name: "bash", arguments: { cmd: "two" } }], timestamp: 1200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB2", toolName: "bash", content: [{ type: "text", text: "outB2" }], isError: false, timestamp: 1210 },
      { role: "assistant", content: [{ type: "text", text: "done B" }], timestamp: 1400, usage: {}, stopReason: "end_turn" },
    ];

    const chainA: ChainRange = { startUserTimestamp: 100, middleToolCallIds: ["tcA"], finalAssistantTimestamp: 400 };
    const chainB: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["tcB1", "tcB2"],
      middleOccurrenceKeys: [occKey("tcB1", 1110), occKey("tcB2", 1210)],
      finalAssistantTimestamp: 1400,
    };

    const { compressedEntries } = await compressEligible([chainA, chainB], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(2);
    const entryA = compressedEntries.find((e) => e.startUserTimestamp === 100)!;
    const entryB = compressedEntries.find((e) => e.startUserTimestamp === 1000)!;
    expect(entryA.bodySource).toBeUndefined();
    expect(entryB.bodySource).toBe("deterministic");

    const cc: ChainCompressionConfig = { enabled: true, rollingWindow: 0, stripFinalAssistantThinking: true, fuseRangeSummary: false };
    const { messages: out } = pruneMessages(messages, indexer, cc);

    const synthetics = out.filter((m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"));
    expect(synthetics).toHaveLength(2);
    const uncoveredSynthetic = synthetics.find((s: any) => s.content[0].text.includes("Deterministic chain compression"));
    expect(uncoveredSynthetic).toBeDefined();
    expectNoOrphanToolResults(out);

    // Covered-output identity: the presence of chain B's deterministic branch
    // must not perturb chain A's rendering at all. Rebuild chain A alone (chain
    // B never existed) and require byte-identical entry + rendered text.
    const referenceIndexer = new ToolCallIndexer();
    const referenceBlockRefs = new BlockRefIssuer();
    referenceIndexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "tcA" }]);
    referenceIndexer.registerSummaryBody(["tcA"], "summary of tcA");
    const referenceMessages = messages.slice(0, 4); // chain A's own span only
    const { compressedEntries: refEntries } = await compressEligible([chainA], 0, {
      indexer: referenceIndexer,
      blockRefs: referenceBlockRefs,
      appendEntry: () => {},
      now: () => 999,
      messages: referenceMessages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });
    expect(refEntries).toHaveLength(1);
    expect(entryA).toEqual(refEntries[0]);

    const { messages: refOut } = pruneMessages(referenceMessages, referenceIndexer, cc);
    const refSynthetic = refOut.find(
      (m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(refSynthetic).toBeDefined();
    const coveredSynthetic = synthetics.find((s: any) => !s.content[0].text.includes("Deterministic chain compression"));
    expect(coveredSynthetic).toEqual(refSynthetic);
  });

  test("recovery through backfill: an uncovered chain's raw output is recoverable via its t<N> ref", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB1", name: "bash", arguments: { cmd: "one" } }], timestamp: 1100, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB1", toolName: "bash", content: [{ type: "text", text: "outB1 raw" }], isError: false, timestamp: 1110 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1400, usage: {}, stopReason: "end_turn" },
    ];
    const chainB: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["tcB1"],
      middleOccurrenceKeys: [occKey("tcB1", 1110)],
      finalAssistantTimestamp: 1400,
    };

    const { compressedEntries } = await compressEligible([chainB], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(1);
    const ref = compressedEntries[0].toolRefs[0];
    const resolved = indexer.resolveToolCallId(ref);
    expect(resolved).toBeDefined();
    expect(indexer.getRecord(resolved!)?.resultText).toBe("outB1 raw");
  });

  test("restart mid-failure-window: index entry persists even when the chain-entry append fails, and converges on retry", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB1", name: "bash", arguments: { cmd: "one" } }], timestamp: 1100, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB1", toolName: "bash", content: [{ type: "text", text: "outB1 raw" }], isError: false, timestamp: 1110 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1400, usage: {}, stopReason: "end_turn" },
    ];
    const chainB: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["tcB1"],
      middleOccurrenceKeys: [occKey("tcB1", 1110)],
      finalAssistantTimestamp: 1400,
    };

    const captured: Array<{ type: string; data: unknown }> = [];
    const flakyAppendEntry = (type: string, data?: unknown) => {
      if (type === CUSTOM_TYPE_CHAIN) throw new Error("session write failed");
      captured.push({ type, data });
    };

    // compressEligible does not catch chain-entry append failures itself
    // (index.ts's caller wraps the whole call in try/catch); the throw
    // propagates, but the index entry (with its refs) is already durable in
    // `captured` by the time it does, per the append-before-commit ordering.
    await expect(
      compressEligible([chainB], 0, {
        indexer,
        blockRefs,
        appendEntry: flakyAppendEntry,
        now: () => 999,
        messages,
        diagnostics: noopDiagnostics,
        backfill: testBackfill,
      }),
    ).rejects.toThrow("session write failed");

    expect(captured.filter((c) => c.type === CUSTOM_TYPE_INDEX)).toHaveLength(1);
    expect(captured.filter((c) => c.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);

    // Rebuild a fresh indexer from exactly what got captured (simulating a restart).
    const branch = captured.map(({ type, data }) => ({ type: "custom", customType: type, data }));
    const rebuilt = new ToolCallIndexer();
    rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => branch } } as any);

    // Re-run with an honest appendEntry: records are already indexed, so this
    // composes-and-persists the chain entry without re-backfilling.
    const captured2: Array<{ type: string; data: unknown }> = [];
    const round2 = await compressEligible([chainB], 0, {
      indexer: rebuilt,
      blockRefs,
      appendEntry: (type, data) => captured2.push({ type, data }),
      now: () => 1000,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(round2.compressedEntries).toHaveLength(1);
    expect(captured2.filter((c) => c.type === CUSTOM_TYPE_INDEX)).toHaveLength(0);
    expect(captured2.filter((c) => c.type === CUSTOM_TYPE_CHAIN)).toHaveLength(1);

    // Refs are identical to round 1's - the index entry (with its refs) never
    // got re-persisted, so round 2 reused the durable ref from round 1.
    const round1IndexEntry = captured.find((c) => c.type === CUSTOM_TYPE_INDEX)!.data as any;
    const round1Refs = round1IndexEntry.refs.map((r: { shortId: string }) => r.shortId);
    expect(round2.compressedEntries[0].toolRefs).toEqual(round1Refs);
  });

  test("multi-chain compact: three uncovered chains compress in one compressEligible call", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    const messages: any[] = [];
    const chains: ChainRange[] = [];
    for (let i = 0; i < 3; i++) {
      const base = 1000 + i * 1000;
      const startTs = base;
      const callTs = base + 100;
      const resultTs = base + 110;
      const finalTs = base + 400;
      const id = `tc${i}`;
      messages.push(
        { role: "user", content: [{ type: "text", text: `go ${i}` }], timestamp: startTs },
        { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { cmd: id } }], timestamp: callTs, usage: {}, stopReason: "tool_use" },
        { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: `out ${i}` }], isError: false, timestamp: resultTs },
        { role: "assistant", content: [{ type: "text", text: `done ${i}` }], timestamp: finalTs, usage: {}, stopReason: "end_turn" },
      );
      chains.push({
        startUserTimestamp: startTs,
        middleToolCallIds: [id],
        middleOccurrenceKeys: [occKey(id, resultTs)],
        finalAssistantTimestamp: finalTs,
      });
    }

    const { compressedEntries } = await compressEligible(chains, 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 9999,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(3);
    expect(compressedEntries.every((e) => e.bodySource === "deterministic")).toBe(true);
  });

  test("fully-deduped chain: backfilled via index-membership filter (not isSummarized), compressed, pre-existing alias entries still resolve", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    // Originals indexed in an earlier flush (as if summarized then).
    indexer.addBatch(
      {
        turnIndex: 0,
        timestamp: 10,
        assistantText: "",
        toolCalls: [
          { toolCallId: "origA", toolName: "bash", args: {}, resultText: "SAME_A", isError: false, resultTimestamp: 20 },
          { toolCallId: "origB", toolName: "bash", args: {}, resultText: "SAME_B", isError: false, resultTimestamp: 21 },
        ],
      },
      () => {},
    );
    indexer.registerSummaryBody([occKey("origA", 20), occKey("origB", 21)], "summary of originals");
    indexer.registerSummaryRefs([
      { shortId: "t1", toolCallId: "origA", resultTimestamp: 20 },
      { shortId: "t2", toolCallId: "origB", resultTimestamp: 21 },
    ]);

    // Pre-existing, unrelated duplicate of origA (registered before the chain
    // under test even ran) - the control used below to prove the chain's own
    // backfill does not disturb unrelated alias entries.
    indexer.registerDuplicate(occKey("dup3", 30), occKey("origA", 20), () => {});

    // The chain's own middle calls (tc1, tc2) were FULLY deduped by the
    // pre-flush content-hash pass: both matched already-indexed originals,
    // so neither was ever sent to the summarizer and neither has a direct
    // index entry - only a dedup-alias entry pointing at origA/origB.
    indexer.registerDuplicate(occKey("tc1", 110), occKey("origA", 20), () => {});
    indexer.registerDuplicate(occKey("tc2", 120), occKey("origB", 21), () => {});

    // isSummarized is true (dedup-alias hit) but the record is NOT in the
    // index map directly - this is exactly the distinction the backfill
    // filter (index membership) must honor instead of isSummarized().
    expect(indexer.isSummarized(occKey("tc1", 110))).toBe(true);
    expect(indexer.getIndex().has(occKey("tc1", 110))).toBe(false);
    expect(indexer.isSummarized(occKey("tc2", 120))).toBe(true);
    expect(indexer.getIndex().has(occKey("tc2", 120))).toBe(false);

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 105, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "SAME_A" }], isError: false, timestamp: 110 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: {} }], timestamp: 115, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "SAME_B" }], isError: false, timestamp: 120 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 200, usage: {}, stopReason: "end_turn" },
    ];
    const chain: ChainRange = {
      startUserTimestamp: 100,
      middleToolCallIds: ["tc1", "tc2"],
      middleOccurrenceKeys: [occKey("tc1", 110), occKey("tc2", 120)],
      finalAssistantTimestamp: 200,
    };

    // Zero coverage: no summary body was ever registered for tc1/tc2's own keys.
    expect(indexer.hasPerBatchSummaryCoveringAny([occKey("tc1", 110), occKey("tc2", 120)])).toBe(false);

    const { compressedEntries } = await compressEligible([chain], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 1,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(1);
    expect(compressedEntries[0].bodySource).toBe("deterministic");

    // tc1/tc2 are now directly backfilled (index-membership filter let them through).
    expect(indexer.getRecord(occKey("tc1", 110))?.resultText).toBe("SAME_A");
    expect(indexer.getRecord(occKey("tc2", 120))?.resultText).toBe("SAME_B");

    // Pre-existing, unrelated alias entry (dup3 -> origA) still resolves unchanged.
    expect(indexer.resolveToolCallId(occKey("dup3", 30))).toBe(occKey("origA", 20));
    expect(indexer.getRecord(occKey("dup3", 30))?.resultText).toBe("SAME_A");

    // Backfilled records never seed contentHashToOriginal - the canonical for
    // "SAME_A"/"SAME_B" content stays origA/origB, unpoisoned by tc1/tc2.
    expect(indexer.lookupByContent("bash", "SAME_A")).toBe(occKey("origA", 20));
    expect(indexer.lookupByContent("bash", "SAME_B")).toBe(occKey("origB", 21));
  });

  test("protected member in an uncovered chain: excluded from backfill index+refs, relocated verbatim at render, unprotected middle dropped", async () => {
    const indexer = new ToolCallIndexer();
    const blockRefs = new BlockRefIssuer();

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB1", name: "bash", arguments: { cmd: "one" } }], timestamp: 1100, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB1", toolName: "bash", content: [{ type: "text", text: "outB1" }], isError: false, timestamp: 1110 },
      { role: "assistant", content: [{ type: "toolCall", id: "tcB2", name: "todowrite", arguments: {} }], timestamp: 1200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId: "tcB2", toolName: "todowrite", content: [{ type: "text", text: "PLAN-STATE-XYZ" }], isError: false, timestamp: 1210 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1400, usage: {}, stopReason: "end_turn" },
    ];
    const chainB: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["tcB1", "tcB2"],
      middleOccurrenceKeys: [occKey("tcB1", 1110), occKey("tcB2", 1210)],
      finalAssistantTimestamp: 1400,
      protectedToolCallIds: ["tcB2"],
    };

    const { compressedEntries } = await compressEligible([chainB], 0, {
      indexer,
      blockRefs,
      appendEntry: () => {},
      now: () => 999,
      messages,
      diagnostics: noopDiagnostics,
      backfill: testBackfill,
    });

    expect(compressedEntries).toHaveLength(1);
    const entry = compressedEntries[0];
    expect(entry.bodySource).toBe("deterministic");

    // (a) protected id absent from the backfilled index entry's records and from toolRefs.
    expect(indexer.getRecord(occKey("tcB2", 1210))).toBeUndefined();
    expect(indexer.getRecord(occKey("tcB1", 1110))).toBeDefined();
    expect(entry.toolRefs).toHaveLength(1);
    expect(entry.toolRefs.map((r) => indexer.resolveToolCallId(r))).not.toContain(occKey("tcB2", 1210));

    // (b) + (c) render: protected relocated verbatim inside the compressed-chain block; unprotected middle dropped.
    const cc: ChainCompressionConfig = { enabled: true, rollingWindow: 0, stripFinalAssistantThinking: true, fuseRangeSummary: false };
    const { messages: out } = pruneMessages(messages, indexer, cc);
    const synthetic = out.find(
      (m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(synthetic).toBeDefined();
    expect(synthetic.content[0].text).toContain('<protected-output tool="todowrite">');
    expect(synthetic.content[0].text).toContain("PLAN-STATE-XYZ");
    expect(out.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
    expectNoOrphanToolResults(out);
  });
});
