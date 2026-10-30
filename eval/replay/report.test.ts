import { expect, test } from "bun:test";
import { renderReplayReport } from "./report.js";

const sentinel = "PRIVATE_SYNTHETIC_7319";
test("private details precede safe coverage and totals with explicit denominators", () => {
  const score = { text: sentinel, inMiddle: true, resultIndex: 0, resultLength: 9000, offset: 4500, inCurrentInput: false, inCandidateInput: false, retainedCurrent: true, retainedCandidate: false, attribution: "scanner-missed" };
  const retained = { outcome: "retained", text: sentinel, attempts: [{ notifications: [], elapsedMs: 3, records: [{ measurements: { input: { value: 11, provenance: "measured" }, output: { value: 7, provenance: "measured" }, cost: { value: .03, provenance: "estimated" } } }] }] };
  const result: any = { exitCode: 2, incomplete: false, rows: [{ stem: sentinel, batchIndex: 0, model: "test/model", assignment: "candidate=A", current: retained, candidate: { ...retained, outcome: "rejected-oversized", text: undefined }, scores: [score, { ...score, text: "gain_key", retainedCurrent: false, retainedCandidate: true, inCandidateInput: true }], selection: [{ resultIndex: 0, k: 3, budgetExhausted: true }], judge: { verdict: "current better", reason: sentinel, attempts: [] } }] };
  const report = renderReplayReport(result, { corpus: "/private/corpus", counts: { sessionsRead: 1, sessionsSkipped: 2, batches: 3, spillPresent: 1, spillMissing: 2, longResults: 1, protectedExclusions: 0 }, eligible: 1, selected: 1, skippedTrivial: 1, skippedSpilled: 1, models: ["test/model"], hashes: { current: "current-hash", candidate: "candidate-hash", rubric: "rubric-hash" } });
  expect(report).toContain("Gate: FAIL (1 regressions)");
  expect(report.indexOf("## Regressions")).toBeLessThan(report.indexOf("## Gains"));
  expect(report.indexOf("## Gains")).toBeLessThan(report.indexOf("## Coverage"));
  const aggregates = report.slice(report.indexOf("## Coverage"));
  expect(aggregates).not.toContain(sentinel);
  for (const fragment of ["current input: 0 / 2", "candidate input: 1 / 2", "current retained: 1 / 2", "candidate retained: 1 / 2", "middle", "scanner-missed", "model-dropped", "K > 0: 1", "budgetExhausted: 1", "candidate better", "current better", "skipped", "error"]) expect(aggregates).toContain(fragment);
  for (const fragment of ["current-hash", "candidate-hash", "rubric-hash", "candidate=A: 1", "rejected-oversized", "11", "0.03", "Summary chars", "mean", "elapsed", "sessions read / skipped: 1 / 2"]) expect(report).toContain(fragment);
});

test("incomplete report marks errors and non-retained summaries earn zero chars", () => {
  const result: any = { incomplete: true, exitCode: 1, rows: [{ stem: "one", batchIndex: 0, model: "test/model", assignment: "candidate=B", scores: [], selection: [], current: { outcome: "unusable:length", attempts: [] }, candidate: { outcome: "error", attempts: [] }, judge: { verdict: "skipped", attempts: [] } }] };
  const report = renderReplayReport(result, { corpus: "/private/corpus", counts: { sessionsRead: 1, sessionsSkipped: 0, batches: 1, spillPresent: 0, spillMissing: 0 }, eligible: 1, selected: 1, skippedTrivial: 0, skippedSpilled: 0, models: ["test/model"], hashes: { current: "a", candidate: "b", rubric: "c" } } as any);
  expect(report).toContain("INCOMPLETE"); expect(report).toContain("Summary chars: sum 0, mean 0"); expect(report).toContain("unusable:length: 1");
});

test("an abandoned attempt makes aggregate usage unavailable despite measured attempts", () => {
  const measured = { notifications: [], elapsedMs: 2, records: [{ measurements: { input: { value: 11, provenance: "measured" }, output: { value: 7, provenance: "measured" }, cost: { value: .03, provenance: "estimated" } } }] };
  const row: any = { stem: "one", batchIndex: 0, model: "test/model", assignment: "candidate=A", scores: [], selection: [], current: { outcome: "unusable:timeout", attempts: [{ records: [], notifications: [], elapsedMs: 10 }] }, candidate: { outcome: "retained", text: "ok", attempts: [measured] }, judge: { verdict: "skipped", attempts: [] } };
  const result: any = { incomplete: false, exitCode: 0, rows: [row, { ...row, current: row.candidate }] };
  const report = renderReplayReport(result, { corpus: "/private/corpus", counts: { sessionsRead: 1, sessionsSkipped: 0, batches: 2 }, eligible: 2, selected: 2, skippedTrivial: 0, skippedSpilled: 0, models: ["test/model"], hashes: { current: "a", candidate: "b", rubric: "c" } } as any);
  const current = report.split("### test/model / current")[1].split("### test/model / candidate")[0];
  expect(current).toContain("input tokens: unavailable; output tokens: unavailable");
  expect(current).toContain("cost: unavailable; attempts: 2");
  expect(report).toContain("input tokens: 22 (measured)");
});
