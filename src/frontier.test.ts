import { describe, expect, test } from "bun:test";
import { PruneFrontierTracker } from "./frontier.js";
import { pruneMessages } from "./pruner.js";
import type { PruneFrontier } from "./types.js";

const base: PruneFrontier = {
  lastAttemptedToolCallId: "tc1",
  lastAttemptedToolName: "bash",
  lastAttemptedTurnIndex: 3,
  lastAttemptedTimestamp: 1000,
  attemptedBatchCount: 1,
  attemptedToolCallCount: 2,
  rawCharCount: 500,
  summaryCharCount: 100,
  outcome: "summarized",
};

describe("PruneFrontierTracker.fromJSON", () => {
  test("round-trips a full frontier", () => {
    const t = new PruneFrontierTracker();
    t.fromJSON({ ...base });
    expect(t.get()?.lastAttemptedToolCallId).toBe("tc1");
    expect(t.get()?.outcome).toBe("summarized");
  });

  test("ignores an entry with no lastAttemptedToolCallId", () => {
    const t = new PruneFrontierTracker();
    t.fromJSON({} as PruneFrontier);
    expect(t.get()).toBeNull();
  });

  test("tolerates a legacy entry carrying the removed thinkingStripBoundaryTimestamp", () => {
    const t = new PruneFrontierTracker();
    t.fromJSON({ ...base, thinkingStripBoundaryTimestamp: 777 } as PruneFrontier);
    expect(t.get()?.lastAttemptedToolCallId).toBe("tc1");
    expect((t.get() as any).thinkingStripBoundaryTimestamp).toBeUndefined();
  });
});

describe("PruneFrontierTracker.reconstructFromSession", () => {
  test("reconstructs from a persisted frontier entry", () => {
    const t = new PruneFrontierTracker();
    const entries = [
      { type: "custom", customType: "context-prune-frontier", data: { ...base, lastAttemptedTimestamp: 2000 } },
    ];
    const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;
    t.reconstructFromSession(fakeCtx);
    expect(t.get()?.lastAttemptedTimestamp).toBe(2000);
  });

  // Spans frontier.ts + pruner.ts on purpose: proves a resumed legacy frontier carries
  // no boundary into an *actively-pruning* pipeline, not just an inert one. Phase 1
  // (stub-replace) and Phase 3 (chain-range-prune) are both wired live here -- a
  // summarized toolResult gets stubbed and a chain entry produces a synthetic
  // <compressed-chain> message -- and every surviving assistant turn, both older and
  // newer than the legacy boundary, still carries its thinking block. This does not
  // (and cannot) prove the deleted thinking-strip phase stays deleted; it proves the
  // phases that remain do not touch thinking regardless of the legacy field's presence.
  test("a legacy frontier entry with thinkingStripBoundaryTimestamp resumes without error and strips nothing", () => {
    const legacyBoundary = 555;
    const t = new PruneFrontierTracker();
    const entries = [
      {
        type: "custom",
        customType: "context-prune-frontier",
        data: { ...base, lastAttemptedTimestamp: 2000, thinkingStripBoundaryTimestamp: legacyBoundary },
      },
    ];
    const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;

    expect(() => t.reconstructFromSession(fakeCtx)).not.toThrow();
    const frontier = t.get();
    expect(frontier).not.toBeNull();
    expect(frontier?.lastAttemptedToolCallId).toBe("tc1");
    expect((frontier as any).thinkingStripBoundaryTimestamp).toBeUndefined();

    const chainEntry = {
      blockId: "b1",
      startUserTimestamp: 560,
      droppedToolCallIds: ["tc-old"],
      finalAssistantTimestamp: 600,
      toolRefs: ["told"],
      compressedAt: 9999,
    };

    const indexer = {
      isSummarized: (id: string) => id === "tc-old" || id === "tc-stub",
      hasLegacyBareRecord: (id: string) => id === "tc-old" || id === "tc-stub",
      getShortRefForToolCallId: (id: string) => (id === "tc-stub" ? "t1" : id === "tc-old" ? "told" : undefined),
      getRecord: () => undefined,
      getChainEntries: () => [chainEntry],
      getPerBatchSummaryTextForToolCallIds: () => "chain summary text",
      findChainEntryByBlockId: () => undefined,
    } as any;

    const mkAsst = (ts: number) => ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", thinkingSignature: "s" },
        { type: "text", text: "x" },
      ],
      timestamp: ts,
      usage: {},
      stopReason: "end_turn",
    });
    const mkAsstWithCall = (ts: number, toolCallId: string) => ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", thinkingSignature: "s" },
        { type: "toolCall", id: toolCallId, name: "bash", arguments: {} },
      ],
      timestamp: ts,
      usage: {},
      stopReason: "tool_use",
    });

    // Timestamps straddle the legacy boundary: old code would have stripped the ones below it.
    // tc-stub is a plain summarized tool result (phase 1 target, outside the chain).
    // tc-old is dropped by the chain entry (phase 3 target).
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
      mkAsst(legacyBoundary - 100),
      mkAsstWithCall(legacyBoundary - 55, "tc-stub"),
      {
        role: "toolResult",
        toolCallId: "tc-stub",
        toolName: "bash",
        content: [{ type: "text", text: "raw stub-target output" }],
        isError: false,
        timestamp: legacyBoundary - 50,
      },
      mkAsst(legacyBoundary - 1),
      { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 560 },
      mkAsstWithCall(570, "tc-old"),
      {
        role: "toolResult",
        toolCallId: "tc-old",
        toolName: "bash",
        content: [{ type: "text", text: "raw chain output" }],
        isError: false,
        timestamp: 575,
      },
      mkAsst(600),
      mkAsst(legacyBoundary + 100),
    ];

    const { messages: out, pruned } = pruneMessages(messages, indexer, {
      enabled: true,
      rollingWindow: 0,
      stripFinalAssistantThinking: false,
      fuseRangeSummary: false,
    });

    // Non-vacuity: the pipeline actually did something.
    expect(pruned).toBe(true);

    // Phase 1 fired: the summarized-but-not-chained toolResult was stub-replaced.
    const stubResult = out.find((m: any) => m.role === "toolResult" && m.toolCallId === "tc-stub") as any;
    expect(stubResult).toBeDefined();
    expect(stubResult.content[0].text).toContain("`t1`");
    expect(stubResult.content[0].text).not.toContain("raw stub-target output");

    // Phase 3 fired: the chain entry produced a synthetic compressed-chain message.
    const synthetic = out.find(
      (m: any) => m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(synthetic).toBeDefined();

    // Every surviving assistant turn, older and newer than the legacy boundary, keeps thinking.
    const assistants = out.filter((m: any) => m.role === "assistant");
    expect(assistants.length).toBe(5);
    expect(assistants.every((a: any) => a.content.some((c: any) => c.type === "thinking"))).toBe(true);
  });
});
