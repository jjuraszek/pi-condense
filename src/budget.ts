import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/**
 * True iff a budget-triggered flush should fire. Computes the ratio ourselves
 * (tokens / contextWindow, a 0–1 fraction) rather than using ContextUsage.percent
 * (a 0–100 value, null when tokens is null). tokens is also null right after a
 * compaction — guarded here.
 */
export function shouldBudgetFlush(
  usage: ContextUsage | undefined,
  threshold: number | null,
): boolean {
  if (threshold == null || threshold <= 0 || threshold > 1) return false;
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return false;
  return usage.tokens / usage.contextWindow >= threshold;
}

/** 0–1 usage fraction, or null when usage is missing / tokens null / window non-positive. */
export function usageFraction(usage: ContextUsage | undefined): number | null {
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return null;
  return usage.tokens / usage.contextWindow;
}

/**
 * True iff this turn's usage fraction rose by at least `delta` versus the previous turn.
 * Mirrors shouldBudgetFlush's guards. previousFraction === null (first turn or post-restart)
 * never fires; the absolute autoBudgetThreshold covers that gap.
 */
export function shouldDeltaFlush(
  usage: ContextUsage | undefined,
  previousFraction: number | null,
  delta: number | null,
): boolean {
  if (delta == null || delta <= 0 || delta > 1) return false;
  if (previousFraction == null) return false;
  const current = usageFraction(usage);
  if (current == null) return false;
  return current - previousFraction >= delta;
}
