import { describe, expect, test } from "bun:test";
import { PruneFrontierTracker } from "./frontier.js";
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

describe("PruneFrontierTracker.fromJSON - thinkingStripBoundaryTimestamp", () => {
  test("round-trips the boundary field", () => {
    const t = new PruneFrontierTracker();
    t.fromJSON({ ...base, thinkingStripBoundaryTimestamp: 777 });
    expect(t.get()?.thinkingStripBoundaryTimestamp).toBe(777);
  });

  test("absent boundary stays undefined (live-count fallback)", () => {
    const t = new PruneFrontierTracker();
    t.fromJSON({ ...base });
    expect(t.get()?.thinkingStripBoundaryTimestamp).toBeUndefined();
  });
});

describe("PruneFrontierTracker.reconstructFromSession - boundary survives reload", () => {
  test("reconstructs thinkingStripBoundaryTimestamp from a persisted frontier entry", () => {
    const t = new PruneFrontierTracker();
    const entries = [
      { type: "custom", customType: "context-prune-frontier", data: { ...base, thinkingStripBoundaryTimestamp: 555 } },
    ];
    const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;
    t.reconstructFromSession(fakeCtx);
    expect(t.get()?.thinkingStripBoundaryTimestamp).toBe(555);
  });

  test("a persisted entry without the field reconstructs as undefined (live-count fallback)", () => {
    const t = new PruneFrontierTracker();
    const entries = [
      { type: "custom", customType: "context-prune-frontier", data: { ...base } },
    ];
    const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;
    t.reconstructFromSession(fakeCtx);
    expect(t.get()).not.toBeNull();
    expect(t.get()?.thinkingStripBoundaryTimestamp).toBeUndefined();
  });
});
