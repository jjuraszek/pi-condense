import type { ContextUsage } from "@mariozechner/pi-coding-agent";

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
