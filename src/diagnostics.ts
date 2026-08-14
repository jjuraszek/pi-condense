import { CUSTOM_TYPE_DIAGNOSTIC } from "./types.js";
import type { DiagnosticEntryData, DiagnosticKind } from "./types.js";

/**
 * Out-of-band diagnostic channel for prune-time degradations. Session entries
 * only - never LLM context, so zero tokens and zero cache-prefix change.
 * Deduped per (kind, dedupKey) so a permanently degraded condition writes one
 * entry, not one per render.
 */
export class DiagnosticSink {
  private readonly seen = new Set<string>();
  private readonly counters: Record<DiagnosticKind, number> = {
    "unresolved-range": 0,
    "range-id-mismatch": 0,
    "orphan-sweep": 0,
    "backfill-empty": 0,
  };

  constructor(private readonly appendEntry: (customType: string, data?: unknown) => void) {}

  report(kind: DiagnosticKind, dedupKey: string, detail: string): void {
    const key = `${kind}:${dedupKey}`;
    if (this.seen.has(key)) return;
    const payload: DiagnosticEntryData = { kind, detail };
    try {
      this.appendEntry(CUSTOM_TYPE_DIAGNOSTIC, payload);
    } catch (err) {
      // The render path must never fail because bookkeeping failed.
      console.error(`pruner: failed to persist ${kind} diagnostic:`, err);
      return;
    }
    this.seen.add(key);
    this.counters[kind]++;
  }

  counts(): Record<DiagnosticKind, number> {
    return { ...this.counters };
  }

  /** Clears session-scoped state; call on session_start/session_tree since this sink is process-scoped, not session-scoped. */
  reset(): void {
    this.seen.clear();
    for (const kind of Object.keys(this.counters) as DiagnosticKind[]) {
      this.counters[kind] = 0;
    }
  }
}
