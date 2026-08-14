import { describe, expect, it, test } from "bun:test";
import { selectEligible, compressEligible, extractChainRecords, buildDeterministicBody } from "./chain-compressor.js";
import type { ChainCompressorIndexerDeps } from "./chain-compressor.js";
import type { ChainRange, ChainCompressionEntry, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_CHAIN } from "./types.js";
import { detectChains } from "./chain-detector.js";
import { inGraceRecoveryToolCallIds } from "./recovery-grace.js";
import { occKey } from "./occurrence-key.js";

function closed(startUserTimestamp: number, toolCallIds: string[] = [`tc-${startUserTimestamp}`]): ChainRange {
  return { startUserTimestamp, middleToolCallIds: toolCallIds, finalAssistantTimestamp: startUserTimestamp + 100 };
}

function emptyMiddle(startUserTimestamp: number): ChainRange {
  return { startUserTimestamp, middleToolCallIds: [], finalAssistantTimestamp: startUserTimestamp + 100 };
}

function open(startUserTimestamp: number): ChainRange {
  return { startUserTimestamp, middleToolCallIds: [], finalAssistantTimestamp: null };
}

describe("selectEligible", () => {
  test("empty input → empty output", () => {
    expect(selectEligible([], 3, new Set())).toEqual([]);
  });

  test("chains.length < K → empty", () => {
    expect(selectEligible([closed(100), closed(300)], 3, new Set())).toHaveLength(0);
  });

  test("chains.length === K → empty (window exactly full)", () => {
    expect(selectEligible([closed(100), closed(300), closed(500)], 3, new Set())).toHaveLength(0);
  });

  test("chains.length === K+1 → 1 chain (oldest)", () => {
    const chains = [closed(100), closed(300), closed(500), closed(700)];
    const result = selectEligible(chains, 3, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].startUserTimestamp).toBe(100);
  });

  test("chains.length === K+3 → 3 chains (3 oldest, in input order)", () => {
    const chains = [100, 300, 500, 700, 900, 1100].map((t) => closed(t));
    const result = selectEligible(chains, 3, new Set());
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.startUserTimestamp)).toEqual([100, 300, 500]);
  });

  test("open chains are never returned regardless of position", () => {
    // 4 closed + 1 open; K=3 → only 1 closed oldest eligible (open doesn't count toward window)
    const chains = [closed(100), open(200), closed(500), closed(700), closed(900)];
    const result = selectEligible(chains, 3, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].startUserTimestamp).toBe(100);
  });

  test("already-compressed chains are excluded and don't count toward window", () => {
    // closed: [100, 300, 500, 700], K=1, already={100,300}
    // not-already-compressed closed: [500, 700]; 2 chains, K=1 → take 1 → [500]
    const chains = [closed(100), closed(300), closed(500), closed(700)];
    const result = selectEligible(chains, 1, new Set([100, 300]));
    expect(result).toHaveLength(1);
    expect(result[0].startUserTimestamp).toBe(500);
  });

  test("K=0 → all closed not-already-compressed chains returned", () => {
    const chains = [closed(100), closed(300), closed(500)];
    expect(selectEligible(chains, 0, new Set())).toHaveLength(3);
  });

  test("K=0 with already-compressed → only not-yet-compressed", () => {
    const chains = [closed(100), closed(300), closed(500)];
    const result = selectEligible(chains, 0, new Set([100]));
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.startUserTimestamp)).toEqual([300, 500]);
  });

  test("empty-middle chains never selected regardless of K", () => {
    // Conversational exchanges (no tool calls) must never occupy rolling-window slots.
    const withTools = closed(300, ["tc1", "tc2"]);
    const withTools2 = closed(400, ["tc3"]);
    // K=0 means compress everything eligible; empty-middle chains should still be excluded.
    const result = selectEligible([emptyMiddle(100), emptyMiddle(200), withTools, withTools2], 0, new Set());
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.startUserTimestamp)).toEqual([300, 400]);
    // K=1 — only withTools2 stays in window; withTools is oldest eligible.
    const result2 = selectEligible([emptyMiddle(100), emptyMiddle(200), withTools, withTools2], 1, new Set());
    expect(result2).toHaveLength(1);
    expect(result2[0].startUserTimestamp).toBe(300);
  });
});

describe("compressEligible", () => {
  function makeIndexer(opts: {
    chainEntries?: ChainCompressionEntry[];
    hasSummary?: boolean;
    toolRefs?: string[];
    perBatchSummaries?: string[];
  } = {}): ChainCompressorIndexerDeps {
    return {
      getChainEntries: () => opts.chainEntries ?? [],
      hasPerBatchSummaryCoveringAny: (_ids: string[]) => opts.hasSummary ?? true,
      getPerBatchSummariesForToolCallIds: (_ids: string[]) => opts.perBatchSummaries ?? [],
      getToolRefsForToolCallIds: (_ids: string[]) => opts.toolRefs ?? [],
      registerChain: (_entry: ChainCompressionEntry) => {},
      getIndex: () => new Map(),
      backfillChainRecords: async () => [{ shortId: "t1", toolCallId: "c1", resultTimestamp: 1050 }],
    } satisfies ChainCompressorIndexerDeps;
  }

  function makeBlockRefs(ids: string[] = ["b1", "b2", "b3"]) {
    let i = 0;
    return { issue: () => ids[i++] ?? `b${i}` } satisfies Pick<import("./block-refs.js").BlockRefIssuer, "issue">;
  }

  // Covered-path fixtures never take the deterministic branch (hasSummary
  // defaults true), so these three fields are unused at runtime - but
  // CompressEligibleDeps requires them, so the fixture supplies inert defaults.
  const NOOP_BACKFILL_DEPS = {
    messages: [] as any[],
    diagnostics: { report: () => {} },
    backfill: { spillThreshold: 1_000_000, spillPreviewBytes: 2048, sessionDir: "/tmp", sessionId: "s1" },
  };

  test("compresses eligible chains and returns entries", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const appended: unknown[] = [];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: (_type, data) => appended.push(data),
      now: () => 9999,
      ...NOOP_BACKFILL_DEPS,
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].blockId).toBe("b1");
    expect(result.compressedEntries[0].startUserTimestamp).toBe(100);
    expect(result.compressedEntries[0].compressedAt).toBe(9999);
    expect(appended).toHaveLength(1);
  });

  test("covered-path chain entry pinned shape (identity pin, pre-deterministic-branch)", async () => {
    // Pins the FULL entry shape produced by the existing covered path before
    // the deterministic zero-LLM branch is introduced. Must stay byte-identical.
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const appended: unknown[] = [];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, toolRefs: ["t1"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: (_type, data) => appended.push(data),
      now: () => 42,
    });
    expect(result.compressedEntries).toHaveLength(1);
    const entry = result.compressedEntries[0];
    expect(entry).toEqual({
      blockId: "b1",
      startUserTimestamp: 100,
      droppedToolCallIds: ["tc1"],
      finalAssistantTimestamp: 200,
      toolRefs: ["t1"],
      compressedAt: 42,
    });
    expect(entry.bodySource).toBeUndefined();
    expect(appended[0]).toEqual(entry);
  });

  test("no coverage -> deterministic compression, not a permanent skip", async () => {
    // Was: "skips chain with no summary and records reason". Per spec
    // 2026-08-14, zero coverage now routes to the deterministic zero-LLM
    // branch instead of a terminal skip.
    const chainMessages = [
      { role: "user", timestamp: 100, content: [{ type: "text", text: "u" }] },
      { role: "assistant", timestamp: 101, content: [{ type: "toolCall", id: "tc1", name: "bash", input: { cmd: "a" } }] },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", timestamp: 150, isError: false, content: [{ type: "text", text: "out" }] },
      { role: "assistant", timestamp: 200, content: [{ type: "text", text: "done" }] },
    ];
    const chains = [closed(100, ["tc1"]), closed(300, ["tc2"]), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: {
        ...makeIndexer({ hasSummary: false }),
        getIndex: () => new Map(),
        backfillChainRecords: async () => [{ shortId: "t1", toolCallId: "tc1", resultTimestamp: 1050 }],
      },
      blockRefs: makeBlockRefs(),
      appendEntry: () => {},
      now: () => 1,
      messages: chainMessages,
      diagnostics: { report: () => {} },
      backfill: { spillThreshold: 1_000_000, spillPreviewBytes: 2048, sessionDir: "/tmp", sessionId: "s1" },
    });
    expect(result.skipped).toHaveLength(0);
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].bodySource).toBe("deterministic");
    expect(result.compressedEntries[0].startUserTimestamp).toBe(100);
  });

  test("reports already-compressed chains in skipped list", async () => {
    const existing: ChainCompressionEntry = {
      blockId: "b1",
      startUserTimestamp: 100,
      droppedToolCallIds: ["tc-100"],
      finalAssistantTimestamp: 200,
      toolRefs: [],
      compressedAt: 0,
    };
    // 4 closed chains, K=3, chain@100 already compressed → none newly eligible
    const chains = [closed(100), closed(300), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ chainEntries: [existing] }),
      blockRefs: makeBlockRefs(),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
    });
    // Primary contract: already-compressed chains must never be double-compressed.
    expect(result.compressedEntries).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({ startUserTimestamp: 100, reason: "already-compressed" });
  });

  test("appendEntry is called with CUSTOM_TYPE_CHAIN as the type argument", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const calls: Array<{ type: string; data: unknown }> = [];
    await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: (type, data) => calls.push({ type, data }),
      now: () => 0,
      ...NOOP_BACKFILL_DEPS,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe(CUSTOM_TYPE_CHAIN);
  });

  test("fuses range summary when >=2 per-batch summaries and fuseRange is provided", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const fuseCalls: string[] = [];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, perBatchSummaries: ["s1", "s2"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
      fuseRange: async (text) => {
        fuseCalls.push(text);
        return "FUSED";
      },
    });
    expect(fuseCalls).toEqual(["s1\n\ns2"]);
    expect(result.compressedEntries[0].rangeSummaryText).toBe("FUSED");
  });

  test("does not fuse a single per-batch summary", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    let fuseCalled = false;
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, perBatchSummaries: ["only-one"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
      fuseRange: async () => {
        fuseCalled = true;
        return "FUSED";
      },
    });
    expect(fuseCalled).toBe(false);
    expect(result.compressedEntries[0].rangeSummaryText).toBeUndefined();
  });

  test("fusion returning null falls back to no rangeSummaryText (still compresses)", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, perBatchSummaries: ["s1", "s2"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
      fuseRange: async () => null,
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].rangeSummaryText).toBeUndefined();
  });

  test("fusion throwing is non-fatal — chain still compresses via fallback", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, perBatchSummaries: ["s1", "s2"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
      fuseRange: async () => {
        throw new Error("boom");
      },
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].rangeSummaryText).toBeUndefined();
  });

  test("copies protectedToolCallIds from the range onto the entry when non-empty", async () => {
    const chainWithProtected: ChainRange = {
      startUserTimestamp: 100,
      middleToolCallIds: ["tc1"],
      finalAssistantTimestamp: 200,
      protectedToolCallIds: ["b"],
    };
    const appended: unknown[] = [];
    const result = await compressEligible(
      [chainWithProtected, closed(300), closed(500), closed(700)],
      3,
      {
        indexer: makeIndexer({ hasSummary: true }),
        blockRefs: makeBlockRefs(["b1"]),
        appendEntry: (_type, data) => appended.push(data),
        now: () => 1,
        ...NOOP_BACKFILL_DEPS,
      },
    );
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].protectedToolCallIds).toEqual(["b"]);
    expect((appended[0] as ChainCompressionEntry).protectedToolCallIds).toEqual(["b"]);
  });

  test("omits protectedToolCallIds field entirely when range has none", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect("protectedToolCallIds" in result.compressedEntries[0]).toBe(false);
  });

  test("no fuseRange provided → no rangeSummaryText (concat fallback at render)", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true, perBatchSummaries: ["s1", "s2"] }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: () => {},
      now: () => 1,
      ...NOOP_BACKFILL_DEPS,
    });
    expect(result.compressedEntries[0].rangeSummaryText).toBeUndefined();
  });
});

describe("selectEligible - recovery grace deferral", () => {
  const chain = (startTs: number, ids: string[]) =>
    ({
      startUserTimestamp: startTs,
      finalAssistantTimestamp: startTs + 10,
      middleToolCallIds: ids,
      protectedToolCallIds: [],
    }) as any;
  it("defers a chain whose span holds an in-grace recovery id", () => {
    const chains = [chain(1, ["a", "t1"]), chain(2, ["b"])];
    const eligible = selectEligible(chains, 0, new Set(), new Set(["t1"]));
    expect(eligible.map((c) => c.startUserTimestamp)).toEqual([2]);
  });
  it("compresses normally when no in-grace recovery id is present", () => {
    const chains = [chain(1, ["a", "t1"]), chain(2, ["b"])];
    const eligible = selectEligible(chains, 0, new Set(), new Set());
    expect(eligible.map((c) => c.startUserTimestamp)).toEqual([1, 2]);
  });
  it("defers only the grace chain without shrinking the rolling-window buffer", () => {
    // 5 eligible chains, rollingWindow=2 -> the window boundary is at n-W=3, so chains
    // 1,2,3 are candidates for compression and 4,5 sit in the protected buffer.
    // The in-grace id lives on chain 4, which is already outside the compress slice and
    // must not affect it. A pre-slice filter (the bug) removes chain 4 from `candidates`
    // before the boundary is computed, shrinking it to 4 items and shifting the cut to
    // n-W=2 -> wrongly dropping chain 3 too. The fix computes the boundary first, so the
    // in-buffer grace id changes nothing and the compress set stays [1, 2, 3].
    const chains = [chain(1, ["a"]), chain(2, ["b"]), chain(3, ["c"]), chain(4, ["d", "t1"]), chain(5, ["e"])];
    const eligible = selectEligible(chains, 2, new Set(), new Set(["t1"]));
    expect(eligible.map((c) => c.startUserTimestamp)).toEqual([1, 2, 3]);
  });
});

describe("occurrence keys in compression", () => {
  const chain = {
    startUserTimestamp: 1000,
    middleToolCallIds: ["bash_23"],
    middleOccurrenceKeys: ["bash_23@1150"],
    protectedToolCallIds: [],
    finalAssistantTimestamp: 1200,
  };

  test("summary/toolRef lookups receive occurrence keys, not bare ids", async () => {
    const asked: string[][] = [];
    const deps = {
      indexer: {
        getChainEntries: () => [],
        hasPerBatchSummaryCoveringAny: (ids: string[]) => (asked.push(ids), true),
        getPerBatchSummariesForToolCallIds: (ids: string[]) => (asked.push(ids), ["s1"]),
        getToolRefsForToolCallIds: (ids: string[]) => (asked.push(ids), ["t1"]),
        registerChain: () => {},
      },
      blockRefs: { issue: () => "b1" },
      appendEntry: () => {},
      now: () => 5000,
    };
    await compressEligible([chain as any], 0, deps as any);
    expect(asked).toEqual([["bash_23@1150"], ["bash_23@1150"]]);
  });

  test("persists droppedOccurrenceKeys alongside droppedToolCallIds", async () => {
    const appended: any[] = [];
    const deps = {
      indexer: {
        getChainEntries: () => [],
        hasPerBatchSummaryCoveringAny: () => true,
        getPerBatchSummariesForToolCallIds: () => ["s1"],
        getToolRefsForToolCallIds: () => ["t1"],
        registerChain: () => {},
      },
      blockRefs: { issue: () => "b1" },
      appendEntry: (_t: string, data: unknown) => appended.push(data),
      now: () => 5000,
    };
    const { compressedEntries } = await compressEligible([chain as any], 0, deps as any);
    expect(compressedEntries[0].droppedToolCallIds).toEqual(["bash_23"]);
    expect(compressedEntries[0].droppedOccurrenceKeys).toEqual(["bash_23@1150"]);
    expect((appended[0] as any).droppedOccurrenceKeys).toEqual(["bash_23@1150"]);
  });

  test("a chain without middleOccurrenceKeys falls back to bare ids", async () => {
    const deps = {
      indexer: {
        getChainEntries: () => [],
        hasPerBatchSummaryCoveringAny: () => true,
        getPerBatchSummariesForToolCallIds: () => ["s1"],
        getToolRefsForToolCallIds: () => ["t1"],
        registerChain: () => {},
      },
      blockRefs: { issue: () => "b1" },
      appendEntry: () => {},
      now: () => 5000,
    };
    const { compressedEntries } = await compressEligible(
      [{ ...chain, middleOccurrenceKeys: undefined } as any],
      0,
      deps as any,
    );
    expect(compressedEntries[0].droppedOccurrenceKeys).toBeUndefined();
  });
});

describe("selectEligible - recovery grace wiring (production boundary)", () => {
  // Crosses the real boundary: real detectChains() + real inGraceRecoveryToolCallIds()
  // feed real selectEligible(). Hand-injecting bare ids (as the suite above does) hides
  // the format mismatch this test pins down.
  it("does not compress a chain whose recovery-query result is still in grace", () => {
    const messages = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "u1" }] },
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "toolCall", id: "t1", name: "context_tree_query", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "context_tree_query",
        timestamp: 100,
        content: [{ type: "text", text: "recovered" }],
      },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "done" }] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "u2" }] },
      { role: "assistant", timestamp: 3, content: [{ type: "toolCall", id: "b", name: "bash", input: {} }] },
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "bash",
        timestamp: 200,
        content: [{ type: "text", text: "ok" }],
      },
      { role: "assistant", timestamp: 4, content: [{ type: "text", text: "done2" }] },
    ];

    const chains = detectChains(messages);
    expect(chains.map((c) => c.startUserTimestamp)).toEqual([1, 3]);

    const inGrace = inGraceRecoveryToolCallIds(messages, 3);
    expect([...inGrace]).toEqual(["t1@100"]);

    const eligible = selectEligible(chains, 0, new Set(), inGrace);
    expect(eligible.map((c) => c.startUserTimestamp)).toEqual([3]);
  });
});

describe("extractChainRecords", () => {
  function messages() {
    return [
      { role: "user", timestamp: 1000, content: [{ type: "text", text: "u" }] },
      { role: "assistant", timestamp: 1001, content: [{ type: "toolCall", id: "c1", name: "bash", input: { cmd: "a" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", timestamp: 1050, isError: false, content: [{ type: "text", text: "out1" }] },
      { role: "assistant", timestamp: 1002, content: [{ type: "toolCall", id: "c2", name: "read", input: { path: "x" } }] },
      { role: "toolResult", toolCallId: "c2", toolName: "read", timestamp: 1150, isError: false, content: [{ type: "text", text: "out2" }] },
      { role: "assistant", timestamp: 1200, content: [{ type: "text", text: "done" }] },
    ];
  }
  const chain = { startUserTimestamp: 1000, finalAssistantTimestamp: 1200, protectedToolCallIds: [] as string[] };

  test("happy path: 2 middle calls -> 2 records with resultTimestamp/turnIndex/resultText", () => {
    const records = extractChainRecords(messages(), chain, () => false);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "a" },
      resultText: "out1",
      isError: false,
      turnIndex: -1,
      timestamp: 1050,
      resultTimestamp: 1050,
    });
    expect(records[1]).toEqual({
      toolCallId: "c2",
      toolName: "read",
      args: { path: "x" },
      resultText: "out2",
      isError: false,
      turnIndex: -1,
      timestamp: 1150,
      resultTimestamp: 1150,
    });
  });

  test("excludes protected and already-indexed occurrence keys", () => {
    const protectedChain = { ...chain, protectedToolCallIds: ["c1"] };
    const indexedKey = occKey("c2", 1150);
    const records = extractChainRecords(messages(), protectedChain, (k) => k === indexedKey);
    expect(records).toHaveLength(0);
  });

  test("falls back to block.args when block.input is absent (batch-capture parity)", () => {
    const msgs = [
      { role: "user", timestamp: 1000, content: [{ type: "text", text: "u" }] },
      { role: "assistant", timestamp: 1001, content: [{ type: "toolCall", id: "c1", name: "bash", args: { cmd: "a" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", timestamp: 1050, isError: false, content: [{ type: "text", text: "out1" }] },
      { role: "assistant", timestamp: 1200, content: [{ type: "text", text: "done" }] },
    ];
    const records = extractChainRecords(msgs, { ...chain, finalAssistantTimestamp: 1200 }, () => false);
    expect(records).toHaveLength(1);
    expect(records[0].args).toEqual({ cmd: "a" });
  });
});

describe("buildDeterministicBody", () => {
  function record(overrides: Partial<ToolCallRecord>): ToolCallRecord {
    return {
      toolCallId: "x",
      toolName: "bash",
      args: {},
      resultText: "",
      isError: false,
      turnIndex: -1,
      timestamp: 0,
      ...overrides,
    };
  }

  test("full grammar pin", () => {
    const records = [
      record({ toolCallId: "a1", toolName: "bash", args: { cmd: "ls" }, resultText: "r1", timestamp: 1000, resultTimestamp: 1000 }),
      record({ toolCallId: "a2", toolName: "bash", args: { cmd: "pwd" }, resultText: "r2", timestamp: 2000, resultTimestamp: 2000 }),
      record({ toolCallId: "a3", toolName: "read", args: { path: "f" }, resultText: "r3", timestamp: 3000, resultTimestamp: 3000 }),
    ];
    const body = buildDeterministicBody(records, ["t1", "t2", "t3"]);
    expect(body).toBe(
      [
        "Deterministic chain compression (no per-batch summary existed for this span; raw outputs recoverable via context_tree_query).",
        "Calls: 3",
        "Tools: bash x2, read x1",
        `Span: ${new Date(1000).toISOString()} -> ${new Date(3000).toISOString()} (2s)`,
        'First: bash {"cmd":"ls"}',
        'Last: read {"path":"f"}',
        "Refs: t1, t2, t3",
      ].join("\n"),
    );
  });

  test("sorts/spans by resultTimestamp when it differs from timestamp", () => {
    // timestamp order is reversed vs resultTimestamp order; resultTimestamp must win.
    const records = [
      record({ toolCallId: "a1", toolName: "bash", args: { cmd: "ls" }, timestamp: 9000, resultTimestamp: 1000 }),
      record({ toolCallId: "a2", toolName: "read", args: { path: "f" }, timestamp: 1000, resultTimestamp: 9000 }),
    ];
    const body = buildDeterministicBody(records, ["t1", "t2"]);
    expect(body).toContain("First: bash ");
    expect(body).toContain("Last: read ");
    expect(body).toContain(`Span: ${new Date(1000).toISOString()} -> ${new Date(9000).toISOString()} (8s)`);
  });

  test("empty toolRefs falls back to bare toolCallIds for the Refs line", () => {
    const records = [
      record({ toolCallId: "a1", toolName: "bash", timestamp: 1000 }),
      record({ toolCallId: "a2", toolName: "read", timestamp: 2000 }),
    ];
    const body = buildDeterministicBody(records, []);
    expect(body).toContain("Refs: a1, a2");
  });

  test("300-char args excerpt is capped at 200 chars + '...'", () => {
    const longArgs = { s: "a".repeat(300) };
    const records = [record({ toolName: "bash", args: longArgs, timestamp: 0 })];
    const body = buildDeterministicBody(records, ["t1"]);
    const firstLine = body.split("\n").find((l) => l.startsWith("First: "))!;
    const excerptText = firstLine.slice("First: bash ".length);
    expect(excerptText).toHaveLength(203);
    expect(excerptText.endsWith("...")).toBe(true);
  });

  test("empty-args chain still produces a non-empty body with Calls/Tools/Span lines", () => {
    const records = [record({ toolName: "bash", args: {}, resultText: "", timestamp: 500 })];
    const body = buildDeterministicBody(records, ["t1"]);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("Calls: 1");
    expect(body).toContain("Tools: bash x1");
    expect(body).toContain("Span:");
  });
});

describe("compressEligible - deterministic zero-LLM branch", () => {
  function chainMessages() {
    return [
      { role: "user", timestamp: 1000, content: [{ type: "text", text: "u" }] },
      { role: "assistant", timestamp: 1001, content: [{ type: "toolCall", id: "c1", name: "bash", input: { cmd: "a" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", timestamp: 1050, isError: false, content: [{ type: "text", text: "out1" }] },
      { role: "assistant", timestamp: 1002, content: [{ type: "toolCall", id: "c2", name: "read", input: { path: "x" } }] },
      { role: "toolResult", toolCallId: "c2", toolName: "read", timestamp: 1150, isError: false, content: [{ type: "text", text: "out2" }] },
      { role: "assistant", timestamp: 1200, content: [{ type: "text", text: "done" }] },
    ];
  }

  function uncoveredChain(): ChainRange {
    return {
      startUserTimestamp: 1000,
      middleToolCallIds: ["c1", "c2"],
      finalAssistantTimestamp: 1200,
      protectedToolCallIds: [],
    };
  }

  function makeDeterministicDeps(opts: {
    messages?: any[];
    indexRecords?: Map<string, ToolCallRecord>;
    backfillImpl?: (records: ToolCallRecord[], opts: unknown) => Promise<import("./types.js").SummaryToolCallRef[]>;
    toolRefs?: string[];
    diagnosticsReport?: (kind: string, dedupKey: string, detail: string) => void;
    fuseRange?: (text: string) => Promise<string | null>;
  } = {}) {
    const backfillCalls: Array<{ records: ToolCallRecord[]; opts: unknown }> = [];
    const registerChainCalls: ChainCompressionEntry[] = [];
    const appended: unknown[] = [];
    const deps = {
      indexer: {
        getChainEntries: () => [],
        hasPerBatchSummaryCoveringAny: () => false,
        getPerBatchSummariesForToolCallIds: () => [],
        getToolRefsForToolCallIds: () => opts.toolRefs ?? ["t1", "t2"],
        registerChain: (entry: ChainCompressionEntry) => registerChainCalls.push(entry),
        getIndex: () => opts.indexRecords ?? new Map<string, ToolCallRecord>(),
        backfillChainRecords: async (records: ToolCallRecord[], backfillOpts: unknown) => {
          backfillCalls.push({ records, opts: backfillOpts });
          if (opts.backfillImpl) return opts.backfillImpl(records, backfillOpts);
          return [
            { shortId: "t1", toolCallId: "c1", resultTimestamp: 1050 },
            { shortId: "t2", toolCallId: "c2", resultTimestamp: 1150 },
          ];
        },
      } satisfies ChainCompressorIndexerDeps,
      blockRefs: { issue: () => "b1" } satisfies Pick<import("./block-refs.js").BlockRefIssuer, "issue">,
      appendEntry: (_type: string, data: unknown) => appended.push(data),
      now: () => 1,
      fuseRange: opts.fuseRange,
      messages: opts.messages ?? chainMessages(),
      diagnostics: { report: opts.diagnosticsReport ?? (() => {}) },
      backfill: { spillThreshold: 1_000_000, spillPreviewBytes: 2048, sessionDir: "/tmp", sessionId: "s1" },
    };
    return { deps, backfillCalls, registerChainCalls, appended };
  }

  test("compresses an uncovered chain with a deterministic body", async () => {
    let fuseCalled = false;
    const { deps, backfillCalls, registerChainCalls } = makeDeterministicDeps({
      fuseRange: async () => {
        fuseCalled = true;
        return "FUSED";
      },
    });
    const result = await compressEligible(
      [{ ...uncoveredChain(), protectedToolCallIds: ["c2"] }],
      0,
      deps as any,
    );
    expect(result.compressedEntries).toHaveLength(1);
    const entry = result.compressedEntries[0];
    expect(entry.bodySource).toBe("deterministic");
    expect(entry.rangeSummaryText).toBeTruthy();
    expect(entry.toolRefs).toEqual(["t1", "t2"]);
    expect(fuseCalled).toBe(false);
    expect(backfillCalls).toHaveLength(1);
    expect(backfillCalls[0].records).toHaveLength(1);
    expect(backfillCalls[0].records.map((r) => r.toolCallId)).not.toContain("c2");
    expect(registerChainCalls).toHaveLength(1);
  });

  test("covered path is untouched: backfill never invoked, entry matches identity pin", async () => {
    const { deps, backfillCalls } = makeDeterministicDeps();
    // Override to simulate coverage so the covered branch (not the deterministic one) runs.
    (deps.indexer as any).hasPerBatchSummaryCoveringAny = () => true;
    (deps.indexer as any).getToolRefsForToolCallIds = () => ["t1"];
    const chain: ChainRange = {
      startUserTimestamp: 100,
      middleToolCallIds: ["tc1"],
      finalAssistantTimestamp: 200,
      protectedToolCallIds: [],
    };
    const result = await compressEligible([chain], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(1);
    const entry = result.compressedEntries[0];
    expect(entry).toEqual({
      blockId: "b1",
      startUserTimestamp: 100,
      droppedToolCallIds: ["tc1"],
      finalAssistantTimestamp: 200,
      toolRefs: ["t1"],
      compressedAt: 1,
    });
    expect(backfillCalls).toHaveLength(0);
  });

  test("fail-closed: backfillChainRecords rejecting keeps the no-summary skip", async () => {
    const { deps, registerChainCalls, appended } = makeDeterministicDeps({
      backfillImpl: async () => {
        throw new Error("spill failed");
      },
    });
    const result = await compressEligible([uncoveredChain()], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(0);
    expect(result.skipped).toEqual([{ startUserTimestamp: 1000, reason: "no-summary" }]);
    expect(registerChainCalls).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  test("retry discriminator: members already indexed, nothing new extracted -> composes from index", async () => {
    const indexed: ToolCallRecord = {
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "a" },
      resultText: "out1",
      isError: false,
      turnIndex: -1,
      timestamp: 1050,
      resultTimestamp: 1050,
    };
    const indexed2: ToolCallRecord = {
      toolCallId: "c2",
      toolName: "read",
      args: { path: "x" },
      resultText: "out2",
      isError: false,
      turnIndex: -1,
      timestamp: 1150,
      resultTimestamp: 1150,
    };
    const index = new Map<string, ToolCallRecord>([
      [occKey("c1", 1050), indexed],
      [occKey("c2", 1150), indexed2],
    ]);
    const chainWithOccKeys: ChainRange = {
      ...uncoveredChain(),
      middleOccurrenceKeys: [occKey("c1", 1050), occKey("c2", 1150)],
    };
    const { deps, backfillCalls } = makeDeterministicDeps({ indexRecords: index });
    const result = await compressEligible([chainWithOccKeys], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].bodySource).toBe("deterministic");
    expect(backfillCalls).toHaveLength(0);
  });

  test("retry discriminator: genuine span mismatch -> skip + backfill-empty diagnostic", async () => {
    const reports: Array<[string, string, string]> = [];
    const { deps } = makeDeterministicDeps({
      messages: [], // span cannot resolve -> extraction empty, index empty
      diagnosticsReport: (kind, dedupKey, detail) => reports.push([kind, dedupKey, detail]),
    });
    const result = await compressEligible([uncoveredChain()], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(0);
    expect(result.skipped).toEqual([{ startUserTimestamp: 1000, reason: "no-summary" }]);
    expect(reports).toHaveLength(1);
    expect(reports[0][0]).toBe("backfill-empty");
    expect(reports[0][1]).toBe("1000");
  });

  test("fully-protected uncovered chain: plain no-summary skip, no backfill-empty diagnostic", async () => {
    // Every middle id is protected -> extraction excludes all of them by design,
    // not by span mismatch. Reporting backfill-empty here would be a false alarm.
    const reports: Array<[string, string, string]> = [];
    const { deps } = makeDeterministicDeps({
      diagnosticsReport: (kind, dedupKey, detail) => reports.push([kind, dedupKey, detail]),
    });
    const chain: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["c1", "c2"],
      finalAssistantTimestamp: 1200,
      protectedToolCallIds: ["c1", "c2"],
    };
    const result = await compressEligible([chain], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(0);
    expect(result.skipped).toEqual([{ startUserTimestamp: 1000, reason: "no-summary" }]);
    expect(reports).toHaveLength(0);
  });

  test("empty-args chain compresses with a non-empty deterministic body", async () => {
    const messages = [
      { role: "user", timestamp: 1000, content: [{ type: "text", text: "u" }] },
      { role: "assistant", timestamp: 1001, content: [{ type: "toolCall", id: "c1", name: "bash", input: {} }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", timestamp: 1050, isError: false, content: [{ type: "text", text: "" }] },
      { role: "assistant", timestamp: 1200, content: [{ type: "text", text: "done" }] },
    ];
    const chain: ChainRange = {
      startUserTimestamp: 1000,
      middleToolCallIds: ["c1"],
      finalAssistantTimestamp: 1200,
      protectedToolCallIds: [],
    };
    const { deps } = makeDeterministicDeps({ messages });
    const result = await compressEligible([chain], 0, deps as any);
    expect(result.compressedEntries).toHaveLength(1);
    const body = result.compressedEntries[0].rangeSummaryText!;
    expect(body).toContain("Calls: 1");
    expect(body).toContain("Tools: bash x1");
    expect(body.length).toBeGreaterThan(0);
  });
});
