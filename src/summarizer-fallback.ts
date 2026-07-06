/**
 * Session-scoped, in-memory state machine for summarizer-model outage fallback.
 *
 * Pure of model IO and notify plumbing: transition methods mutate state and
 * return a transition tag; the caller (runSummarization) performs the LLM runs
 * and emits any notify text. `now()` is injected for deterministic tests.
 *
 * Engaged ONLY on transient (outage-shaped) failures of the configured
 * summarizer model, and only when a distinct fallback model exists. Sticky:
 * once in fallback, all calls route to the session model until a single
 * per-cooldown probe of the primary succeeds. See
 * doc/specs/2026-07-06-summarizer-outage-fallback.md.
 */

/** Re-probe cooldown while in fallback. Internal; deliberately not configurable. */
export const COOLDOWN_MS = 10 * 60 * 1000;

export type FallbackTransition = "enter" | "recover" | "none";
export type CallTarget = "primary" | "fallback";

export interface TargetDecision {
  target: CallTarget;
  wasProbe: boolean;
}

/** Minimal structural view of a pi-ai Model (avoids the generic Api type param). */
export interface ModelLike {
  id: string;
  provider: string;
  name?: string;
}

export class FallbackController {
  inFallback = false;
  private lastProbeAt = 0;
  private owedEnterWarning = false;

  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.inFallback = false;
    this.lastProbeAt = 0;
    this.owedEnterWarning = false;
  }

  /**
   * True when primary and the session model are genuinely different. When
   * false the controller must NOT be consulted (behavior identical to today).
   * `Model.provider` is a plain string in pi-ai, not an object.
   */
  static hasDistinctFallback(
    primary: ModelLike | undefined,
    sessionModel: ModelLike | undefined,
  ): boolean {
    if (!primary || !sessionModel) return false;
    return primary.provider !== sessionModel.provider || primary.id !== sessionModel.id;
  }

  /**
   * Pick the model target for the next call and, if eligible, claim the single
   * per-cooldown probe. The claim is synchronous: the first of N concurrent
   * callers in a flush advances `lastProbeAt`, so siblings see the cooldown as
   * not elapsed and route to the fallback. Call before the first await.
   */
  chooseTarget(): TargetDecision {
    if (!this.inFallback) return { target: "primary", wasProbe: false };
    if (this.now() - this.lastProbeAt >= COOLDOWN_MS) {
      this.lastProbeAt = this.now();
      return { target: "primary", wasProbe: true };
    }
    return { target: "fallback", wasProbe: false };
  }

  /** Primary (initial or probe) failed transiently but the fallback retry succeeded. */
  onPrimaryFailFallbackOk(_wasProbe: boolean): FallbackTransition {
    this.lastProbeAt = this.now();
    if (this.owedEnterWarning) {
      this.owedEnterWarning = false;
      this.inFallback = true;
      return "enter";
    }
    if (!this.inFallback) {
      this.inFallback = true;
      return "enter";
    }
    // probe transient, rescued by fallback -> stay, no notify
    return "none";
  }

  /** Both the primary call and the fallback retry failed transiently. */
  onBothDown(): void {
    this.lastProbeAt = this.now();
    if (!this.inFallback) {
      this.inFallback = true;
      this.owedEnterWarning = true;
    }
  }

  /** A steady-state fallback call (already in fallback) failed transiently. */
  onFallbackOnlyFail(): void {
    this.lastProbeAt = this.now();
  }

  /** A primary call succeeded. Recover only when it was the probe. */
  onPrimarySuccess(wasProbe: boolean): FallbackTransition {
    if (wasProbe && this.inFallback) {
      this.inFallback = false;
      this.owedEnterWarning = false;
      return "recover";
    }
    return "none";
  }

  /** A steady-state fallback call succeeded. Fire the deferred enter warning if owed. */
  onFallbackSuccess(): FallbackTransition {
    if (this.owedEnterWarning) {
      this.owedEnterWarning = false;
      return "enter";
    }
    return "none";
  }
}
