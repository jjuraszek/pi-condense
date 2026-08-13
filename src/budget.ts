import type { ContextUsage } from "@earendil-works/pi-coding-agent";

// Ceiling on what the budget triggers treat as the context window. Advertised
// windows reach 1M, which makes any (0,1] fraction unreachable in a real session.
// The two triggers apply it in different shapes on purpose: the threshold is a
// LEVEL, so the cap bounds the level itself (min(CAP, threshold * window)); the
// delta is a GROWTH RATE, where a 300k ceiling could never bind, so the cap
// enters through the denominator instead (delta * min(window, CAP)).
export const MAX_BUDGET_WINDOW = 300_000;

/**
 * True iff a budget-triggered flush should fire: at `threshold` of the model's
 * window, or at MAX_BUDGET_WINDOW tokens, whichever comes first. Computes the
 * level ourselves rather than using ContextUsage.percent (a 0–100 value, null
 * when tokens is null). tokens is also null right after a compaction — guarded here.
 */
export function shouldBudgetFlush(
  usage: ContextUsage | undefined,
  threshold: number | null,
): boolean {
  if (threshold == null || threshold <= 0 || threshold > 1) return false;
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return false;
  return usage.tokens >= Math.min(MAX_BUDGET_WINDOW, threshold * usage.contextWindow);
}

/**
 * Usage fraction against the effective window (min(contextWindow, MAX_BUDGET_WINDOW)),
 * or null when usage is missing / tokens null / window non-positive. NOT bounded by 1:
 * 600k tokens on a 1M window returns 2.0. Deliberately unclamped — clamping would make
 * shouldDeltaFlush saturate above the ceiling and stop re-arming.
 */
export function usageFraction(usage: ContextUsage | undefined): number | null {
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return null;
  return usage.tokens / Math.min(usage.contextWindow, MAX_BUDGET_WINDOW);
}

/**
 * True iff this turn's usage fraction rose by at least `delta` versus the previous turn,
 * i.e. growth of at least `delta * min(contextWindow, MAX_BUDGET_WINDOW)` tokens.
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
