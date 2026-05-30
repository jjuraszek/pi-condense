import { describe, expect, test } from "bun:test";
import { selectEligible, compressEligible } from "./chain-compressor.js";
import type { ChainCompressorIndexerDeps } from "./chain-compressor.js";
import type { ChainRange, ChainCompressionEntry } from "./types.js";
import { CUSTOM_TYPE_CHAIN } from "./types.js";

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
    } satisfies ChainCompressorIndexerDeps;
  }

  function makeBlockRefs(ids: string[] = ["b1", "b2", "b3"]) {
    let i = 0;
    return { issue: () => ids[i++] ?? `b${i}` } satisfies Pick<import("./block-refs.js").BlockRefIssuer, "issue">;
  }

  test("compresses eligible chains and returns entries", async () => {
    const chains = [closed(100, ["tc1"]), closed(300), closed(500), closed(700)];
    const appended: unknown[] = [];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: true }),
      blockRefs: makeBlockRefs(["b1"]),
      appendEntry: (_type, data) => appended.push(data),
      now: () => 9999,
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].blockId).toBe("b1");
    expect(result.compressedEntries[0].startUserTimestamp).toBe(100);
    expect(result.compressedEntries[0].compressedAt).toBe(9999);
    expect(appended).toHaveLength(1);
  });

  test("skips chain with no summary and records reason", async () => {
    const chains = [closed(100, ["tc1"]), closed(300, ["tc2"]), closed(500), closed(700)];
    const result = await compressEligible(chains, 3, {
      indexer: makeIndexer({ hasSummary: false }),
      blockRefs: makeBlockRefs(),
      appendEntry: () => {},
      now: () => 1,
    });
    expect(result.compressedEntries).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({ startUserTimestamp: 100, reason: "no-summary" });
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
    });
    expect(result.compressedEntries[0].rangeSummaryText).toBeUndefined();
  });
});
