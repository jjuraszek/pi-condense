import { expect } from "bun:test";
import { sweepOrphanToolResults } from "./orphan-sweep.js";
import { pruneMessages } from "./pruner.js";
import { DiagnosticSink } from "./diagnostics.js";

/** Shared by chain-range-prune.test.ts and id-collision.integration.test.ts. */
export function expectNoOrphanToolResults(messages: any[]): void {
  let open = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      open = new Set((m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
    } else if (m.role === "toolResult") {
      expect(open.has(m.toolCallId)).toBe(true);
      open.delete(m.toolCallId);
    }
  }
}

/**
 * G4/C3: proof that the orphan sweep (src/pruner.ts Phase 4) is a net, not a
 * crutch. Runs the real `sweepOrphanToolResults` (the exact function backing
 * Phase 4's diagnostic) over an already-pruned message array and fails if it
 * finds anything to sweep. Equivalent to asserting the Phase 4 diagnostic
 * never fires for this output: `sweepOrphanToolResults` returns the input
 * array reference and an empty `sweptIds` when nothing is orphaned, which is
 * precisely the condition under which `pruneMessages` skips the
 * `diagnostics?.report("orphan-sweep", ...)` call.
 */
export function expectZeroOrphanSweep(messages: any[]): void {
  const { messages: swept, sweptIds } = sweepOrphanToolResults(messages);
  expect(sweptIds).toEqual([]);
  expect(swept).toBe(messages);
}

/**
 * G4/C3: wraps a `pruneMessages` call with a counting `DiagnosticSink` and
 * fails if the `orphan-sweep` diagnostic fires. For fixtures that already go
 * through the full pruner pipeline (pruner.test.ts), this is the more direct
 * proof than `expectZeroOrphanSweep` since it exercises the actual Phase 4
 * call site, not just the underlying pure function.
 */
export function pruneWithZeroSweepAssertion(
  messages: any[],
  indexer: any,
  chainCompression?: any,
  errorPurge?: any,
  protection?: any,
  recoveryGraceTurns: number = 0,
): ReturnType<typeof pruneMessages> {
  const sink = new DiagnosticSink(() => {});
  const result = pruneMessages(messages, indexer, chainCompression, errorPurge, protection, recoveryGraceTurns, sink);
  expect(sink.counts()["orphan-sweep"]).toBe(0);
  return result;
}
