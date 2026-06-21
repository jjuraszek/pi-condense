import type { SummarizerStats, ExternalCostUpdate, LiveReclaim } from "./types.js";
import { CUSTOM_TYPE_STATS, EXTERNAL_COST_CHANNEL, EXTERNAL_COST_SOURCE } from "./types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Usage shape returned by the LLM `complete()` call.
 * Mirrors the `Usage` interface from `@earendil-works/pi-ai` but declared locally
 * so we don't need a runtime import just for the type.
 */
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Accumulates cumulative token/cost stats for summarizer LLM calls.
 * Stats are persisted to the session via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`
 * and reconstructed on `session_start` / `session_tree`.
 */
export class StatsAccumulator {
  private stats: SummarizerStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    callCount: 0,
    chainsCompressed: 0,
    rangesSummarized: 0,
  };
  private baseline = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
  private liveReclaim: LiveReclaim | undefined = undefined;

  /** Add usage data from one summarizer LLM call. */
  add(usage: Usage): void {
    this.stats.totalInputTokens += usage.input ?? 0;
    this.stats.totalOutputTokens += usage.output ?? 0;
    this.stats.totalCost += usage.cost?.total ?? 0;
    this.stats.callCount += 1;
  }

  /** Return session-delta spend (current stats minus baseline set at reconstructFromSession). */
  getSessionDelta(): { totalCost: number; inputTokens: number; outputTokens: number } {
    return {
      totalCost: this.stats.totalCost - this.baseline.totalCost,
      inputTokens: this.stats.totalInputTokens - this.baseline.totalInputTokens,
      outputTokens: this.stats.totalOutputTokens - this.baseline.totalOutputTokens,
    };
  }

  /** Store the before/after context-char measurement from the last prune. */
  setLiveReclaim(beforeChars: number, afterChars: number): void {
    this.liveReclaim = { beforeChars, afterChars };
  }

  /** Return the last live-reclaim measurement, or undefined if none yet. */
  getLiveReclaim(): LiveReclaim | undefined {
    return this.liveReclaim;
  }

  /** Return a snapshot of the current cumulative stats. */
  getStats(): SummarizerStats {
    return { ...this.stats };
  }

  /** Increment the chain-compression counter. */
  addChainsCompressed(n: number): void {
    this.stats.chainsCompressed += n;
  }

  /** Increment the fused-range-summary counter. */
  addRangesSummarized(n: number): void {
    this.stats.rangesSummarized += n;
  }

  /** Reset all accumulated stats to zero. Produces the same state as a fresh accumulator. */
  reset(): void {
    this.stats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      callCount: 0,
      chainsCompressed: 0,
      rangesSummarized: 0,
    };
    this.baseline = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
    this.liveReclaim = undefined;
  }

  /** Serialize stats for session persistence. */
  toJSON(): SummarizerStats {
    return { ...this.stats };
  }

  /** Restore stats from a previously persisted snapshot. */
  fromJSON(data: SummarizerStats): void {
    this.stats = {
      totalInputTokens: data.totalInputTokens ?? 0,
      totalOutputTokens: data.totalOutputTokens ?? 0,
      totalCost: data.totalCost ?? 0,
      callCount: data.callCount ?? 0,
      chainsCompressed: data.chainsCompressed ?? 0,
      rangesSummarized: data.rangesSummarized ?? 0,
    };
  }

  /**
   * Reconstruct stats from session history by scanning all custom entries
   * with customType === CUSTOM_TYPE_STATS.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === CUSTOM_TYPE_STATS
      ) {
        const data = (entry as any).data as SummarizerStats;
        if (data) {
          this.fromJSON(data);
        }
      }
    }
    this.baseline = {
      totalInputTokens: this.stats.totalInputTokens,
      totalOutputTokens: this.stats.totalOutputTokens,
      totalCost: this.stats.totalCost,
    };
  }

  /**
   * Persist current stats to the session.
   * Each call appends a new entry; on reconstructFromSession we scan
   * all entries and apply the LAST one (since each entry is a full snapshot).
   */
  persist(pi: ExtensionAPI): void {
    pi.appendEntry(CUSTOM_TYPE_STATS, this.toJSON());
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format compact counts like Pi's status line (e.g. "1.2k", "340") */
export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format token counts like Pi's status line (e.g. "1.2k", "340") */
export function formatTokens(n: number): string {
  return formatCompactCount(n);
}

/** Format live char progress like "1.2k summary chars / 8.4k raw chars". */
export function formatCharProgress(receivedChars: number, rawChars?: number): string {
  const receivedLabel = `${formatCompactCount(receivedChars)} summary char${receivedChars === 1 ? "" : "s"}`;
  if (rawChars == null) return receivedLabel;
  return `${receivedLabel} / ${formatCompactCount(rawChars)} raw char${rawChars === 1 ? "" : "s"}`;
}

/** Format cost like "$0.003" */
export function formatCost(n: number): string {
  if (n < 0.001 && n > 0) return `<$0.001`;
  return `$${n.toFixed(3)}`;
}

/**
 * Emit the session-delta cost from `accumulator` on EXTERNAL_COST_CHANNEL.
 * Idempotent from the aggregator's perspective: keyed by source, re-emitting overwrites.
 */
export function emitExternalCost(pi: ExtensionAPI, accumulator: StatsAccumulator): void {
  const delta = accumulator.getSessionDelta();
  const payload: ExternalCostUpdate = {
    source: EXTERNAL_COST_SOURCE,
    totalCost: delta.totalCost,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
  };
  pi.events.emit(EXTERNAL_COST_CHANNEL, payload);
}
