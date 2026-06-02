import { describe, it, expect } from "bun:test";
import { shouldBudgetFlush, shouldDeltaFlush, usageFraction } from "./budget.js";

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
});

describe("usageFraction", () => {
  it("returns null for undefined / null tokens / non-positive window", () => {
    expect(usageFraction(undefined)).toBeNull();
    expect(usageFraction(usage(null, 1000))).toBeNull();
    expect(usageFraction(usage(900, 0))).toBeNull();
  });
  it("returns the 0–1 fraction", () => {
    expect(usageFraction(usage(750, 1000))).toBe(0.75);
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
});
