import { describe, it, expect } from "bun:test";
import { shouldBudgetFlush } from "./budget.js";

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
