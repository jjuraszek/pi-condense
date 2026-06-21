import { describe, expect, it } from "bun:test";
import {
  StatsAccumulator,
  emitExternalCost,
} from "./stats.js";
import {
  CUSTOM_TYPE_STATS,
  EXTERNAL_COST_CHANNEL,
  EXTERNAL_COST_SOURCE,
} from "./types.js";

// Minimal Usage shape matching the private interface in stats.ts
function makeUsage(input: number, output: number, costTotal: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costTotal,
    },
  };
}

describe("StatsAccumulator.getSessionDelta", () => {
  it("(a) fresh accumulator: delta equals what was added", () => {
    const acc = new StatsAccumulator();
    acc.add(makeUsage(100, 50, 0.01));
    const delta = acc.getSessionDelta();
    expect(delta.totalCost).toBeCloseTo(0.01);
    expect(delta.inputTokens).toBe(100);
    expect(delta.outputTokens).toBe(50);
  });

  it("(b) after reconstructFromSession, prior totals are excluded from delta", () => {
    const acc = new StatsAccumulator();

    // Build a mock ctx that returns one CUSTOM_TYPE_STATS entry with prior totals
    const priorStats = {
      totalInputTokens: 500,
      totalOutputTokens: 250,
      totalCost: 0.05,
      callCount: 3,
      chainsCompressed: 1,
      rangesSummarized: 0,
    };
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: CUSTOM_TYPE_STATS,
            data: priorStats,
          },
        ],
      },
    } as any;

    acc.reconstructFromSession(mockCtx);

    // Delta should be zero right after reconstruction
    const deltaAfterRecon = acc.getSessionDelta();
    expect(deltaAfterRecon.totalCost).toBeCloseTo(0);
    expect(deltaAfterRecon.inputTokens).toBe(0);
    expect(deltaAfterRecon.outputTokens).toBe(0);

    // A subsequent add should show only the new spend
    acc.add(makeUsage(200, 80, 0.02));
    const deltaAfterAdd = acc.getSessionDelta();
    expect(deltaAfterAdd.totalCost).toBeCloseTo(0.02);
    expect(deltaAfterAdd.inputTokens).toBe(200);
    expect(deltaAfterAdd.outputTokens).toBe(80);
  });
});

describe("StatsAccumulator.getLiveReclaim / setLiveReclaim", () => {
  it("(c) undefined initially; round-trips after set", () => {
    const acc = new StatsAccumulator();
    expect(acc.getLiveReclaim()).toBeUndefined();
    acc.setLiveReclaim(1000, 200);
    expect(acc.getLiveReclaim()).toEqual({ beforeChars: 1000, afterChars: 200 });
  });
});

describe("emitExternalCost", () => {
  it("(d) emits exactly one event on EXTERNAL_COST_CHANNEL with session delta", () => {
    const acc = new StatsAccumulator();
    acc.add(makeUsage(100, 50, 0.01));

    const calls: Array<{ channel: string; data: unknown }> = [];
    const fakePi = {
      events: {
        emit: (channel: string, data: unknown) => {
          calls.push({ channel, data });
        },
      },
    } as any;

    emitExternalCost(fakePi, acc);

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe(EXTERNAL_COST_CHANNEL);
    const payload = calls[0].data as any;
    expect(payload.source).toBe(EXTERNAL_COST_SOURCE);
    expect(payload.totalCost).toBeCloseTo(0.01);
    expect(payload.inputTokens).toBe(100);
    expect(payload.outputTokens).toBe(50);
  });
});
