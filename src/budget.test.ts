import { describe, it, expect } from "bun:test";
import { shouldBudgetFlush, shouldDeltaFlush, usageFraction, MAX_BUDGET_WINDOW } from "./budget.js";

const usage = (tokens: number | null, contextWindow: number) =>
  ({ tokens, contextWindow, percent: null }) as any;

describe("shouldBudgetFlush", () => {
  it("is false when threshold is null", () => {
    expect(shouldBudgetFlush(usage(900, 1000), null)).toBe(false);
  });
  it("is false for non-positive or >1 thresholds", () => {
    expect(shouldBudgetFlush(usage(900, 1000), 0)).toBe(false);
    expect(shouldBudgetFlush(usage(900, 1000), 1.5)).toBe(false);
  });
  it("is false when usage is undefined", () => {
    expect(shouldBudgetFlush(undefined, 0.8)).toBe(false);
  });
  it("is false when tokens is null (post-compaction)", () => {
    expect(shouldBudgetFlush(usage(null, 1000), 0.8)).toBe(false);
  });
  it("is false when contextWindow is non-positive", () => {
    expect(shouldBudgetFlush(usage(900, 0), 0.8)).toBe(false);
  });
  it("is true at or over the threshold, false under", () => {
    expect(shouldBudgetFlush(usage(800, 1000), 0.8)).toBe(true);
    expect(shouldBudgetFlush(usage(900, 1000), 0.8)).toBe(true);
    expect(shouldBudgetFlush(usage(799, 1000), 0.8)).toBe(false);
  });

  it("treats threshold of exactly 1.0 as valid (flush only at 100%)", () => {
    expect(shouldBudgetFlush(usage(1000, 1000), 1)).toBe(true);
    expect(shouldBudgetFlush(usage(999, 1000), 1)).toBe(false);
  });

  it("exposes the window ceiling as 300k", () => {
    expect(MAX_BUDGET_WINDOW).toBe(300_000);
  });

  it("caps the trigger level at MAX_BUDGET_WINDOW on a huge window", () => {
    expect(shouldBudgetFlush(usage(300_000, 1_000_000), 0.4)).toBe(true);
    expect(shouldBudgetFlush(usage(299_999, 1_000_000), 0.4)).toBe(false);
    expect(shouldBudgetFlush(usage(300_000, 1_000_000), 0.9)).toBe(true);
  });

  it("leaves models at or below the ceiling unchanged", () => {
    expect(shouldBudgetFlush(usage(80_000, 200_000), 0.4)).toBe(true);
    expect(shouldBudgetFlush(usage(79_999, 200_000), 0.4)).toBe(false);
    expect(shouldBudgetFlush(usage(230_400, 256_000), 0.9)).toBe(true);
    expect(shouldBudgetFlush(usage(230_399, 256_000), 0.9)).toBe(false);
    expect(shouldBudgetFlush(usage(300_000, 300_000), 1)).toBe(true);
  });

  it("lets a low threshold govern below the ceiling on a huge window", () => {
    expect(shouldBudgetFlush(usage(100_000, 1_000_000), 0.1)).toBe(true);
    expect(shouldBudgetFlush(usage(99_999, 1_000_000), 0.1)).toBe(false);
  });
});

describe("usageFraction", () => {
  it("returns null for undefined / null tokens / non-positive window", () => {
    expect(usageFraction(undefined)).toBeNull();
    expect(usageFraction(usage(null, 1000))).toBeNull();
    expect(usageFraction(usage(900, 0))).toBeNull();
  });
  it("returns the fraction against the effective window", () => {
    expect(usageFraction(usage(750, 1000))).toBe(0.75);
  });

  it("is not clamped above 1 when the window exceeds the ceiling", () => {
    expect(usageFraction(usage(600_000, 1_000_000))).toBe(2);
    expect(usageFraction(usage(80_000, 200_000))).toBe(0.4);
  });
});

describe("shouldDeltaFlush", () => {
  it("is false when delta is null, non-positive, or >1", () => {
    expect(shouldDeltaFlush(usage(900, 1000), 0.5, null)).toBe(false);
    expect(shouldDeltaFlush(usage(900, 1000), 0.5, 0)).toBe(false);
    expect(shouldDeltaFlush(usage(900, 1000), 0.5, 1.5)).toBe(false);
  });
  it("is false when previousFraction is null (first turn / post-restart)", () => {
    expect(shouldDeltaFlush(usage(900, 1000), null, 0.15)).toBe(false);
  });
  it("is false when usage missing or tokens null", () => {
    expect(shouldDeltaFlush(undefined, 0.5, 0.15)).toBe(false);
    expect(shouldDeltaFlush(usage(null, 1000), 0.5, 0.15)).toBe(false);
  });
  it("fires when the jump meets the delta, not below", () => {
    expect(shouldDeltaFlush(usage(700, 1000), 0.5, 0.15)).toBe(true);  // 0.20 >= 0.15
    expect(shouldDeltaFlush(usage(650, 1000), 0.5, 0.15)).toBe(true);  // 0.15 exactly
    expect(shouldDeltaFlush(usage(640, 1000), 0.5, 0.15)).toBe(false); // 0.14 < 0.15
    expect(shouldDeltaFlush(usage(600, 1000), 0.5, 0.15)).toBe(false); // 0.10 < 0.15
  });

  it("measures growth against the capped window on a huge-window model", () => {
    // previousFraction for 100k tokens on a 1M window = 100_000 / 300_000
    const prev = 100_000 / MAX_BUDGET_WINDOW;
    expect(shouldDeltaFlush(usage(130_000, 1_000_000), prev, 0.1)).toBe(true);
    expect(shouldDeltaFlush(usage(120_000, 1_000_000), prev, 0.1)).toBe(false);
  });

  it("leaves the growth requirement unchanged at or below the ceiling", () => {
    const prev = 40_000 / 200_000; // 0.2
    expect(shouldDeltaFlush(usage(100_000, 200_000), prev, 0.3)).toBe(true);  // +60k
    expect(shouldDeltaFlush(usage(99_000, 200_000), prev, 0.3)).toBe(false);  // +59k
  });

  it("keeps re-arming above the ceiling, where the fraction exceeds 1", () => {
    const prev = 600_000 / MAX_BUDGET_WINDOW; // 2.0 - unclamped by design
    expect(shouldDeltaFlush(usage(630_000, 1_000_000), prev, 0.1)).toBe(true);
    expect(shouldDeltaFlush(usage(620_000, 1_000_000), prev, 0.1)).toBe(false);
  });
});
