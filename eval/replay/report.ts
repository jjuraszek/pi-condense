import type { ReplayCounts } from "./extract.js";
import type { ReplayResult, ReplayRow, EvidenceScore, Arm, Attempt } from "./run.js";

export interface ReportMetadata {
  corpus: string;
  counts: ReplayCounts;
  eligible: number;
  selected: number;
  skippedTrivial: number;
  skippedSpilled: number;
  models: string[];
  hashes: { current: string; candidate: string; rubric: string };
}
const cell = (value: unknown) => String(value ?? "-").replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
const regressions = (s: EvidenceScore) => s.retainedCurrent && !s.retainedCandidate;
const gains = (s: EvidenceScore) => !s.retainedCurrent && s.retainedCandidate;

export function renderReplayReport(result: ReplayResult, meta: ReportMetadata): string {
  const all = result.rows.flatMap(row => row.scores), middle = all.filter(s => s.inMiddle);
  const n = all.filter(regressions).length;
  const lines = [`# Gate: ${n ? `FAIL (${n} regressions)` : "pass"}`, ...(result.incomplete ? ["INCOMPLETE - execution errors; gate is not a go decision."] : []), `Corpus: ${cell(meta.corpus)}`, `sessions read / skipped: ${meta.counts.sessionsRead} / ${meta.counts.sessionsSkipped}`, `batches total / eligible / selected: ${meta.counts.batches} / ${meta.eligible} / ${meta.selected}`, `skipped-trivial: ${meta.skippedTrivial}; skipped-spilled: ${meta.skippedSpilled}`, `spilled sidecar present / missing: ${meta.counts.spillPresent} / ${meta.counts.spillMissing}`, `results over 8000: ${meta.counts.longResults}; protected exclusions: ${meta.counts.protectedExclusions}`, `Models: ${meta.models.join(", ")}`, `Current prompt sha256: ${meta.hashes.current}`, `Candidate prompt sha256: ${meta.hashes.candidate}`, `Judge rubric sha256: ${meta.hashes.rubric}`, `Assignments: candidate=A: ${result.rows.filter(r => r.assignment === "candidate=A").length}; candidate=B: ${result.rows.filter(r => r.assignment === "candidate=B").length}`];
  for (const model of meta.models) for (const arm of ["current", "candidate"] as const) {
    const arms = result.rows.filter(r => r.model === model).map(r => r[arm]);
    const attempts = arms.flatMap(a => a.attempts);
    const retained = arms.filter(a => a.outcome === "retained");
    const chars = retained.reduce((n, a) => n + (a.text?.length ?? 0), 0);
    lines.push(`\n### ${model} / ${arm}`, outcomeCounts(arms), measurements(attempts), `Summary chars: sum ${chars}, mean ${retained.length ? chars / retained.length : 0}`);
  }
  lines.push("\n### Judge usage", measurements(result.rows.flatMap(r => r.judge.attempts)));
  function details(title: string, predicate: (s: EvidenceScore) => boolean, verdict: string) {
    lines.push(`\n## ${title}`, "| Session | Batch | Model | Result length | Oracle string | inMiddle | Attribution | Judge | Reason |", "|---|---|---|---|---|---|---|---|---|");
    for (const row of result.rows) {
      for (const score of row.scores.filter(predicate)) lines.push(detailRow(row, score));
      if (row.judge.verdict === verdict) lines.push(detailRow(row));
    }
  }
  details("Regressions", regressions, "current better");
  details("Gains", gains, "candidate better");
  lines.push("\n## Coverage", `Oracle strings total: ${all.length}; middle-only: ${middle.length}`);
  for (const arm of ["current", "candidate"] as const) {
    const input = (s: EvidenceScore) => arm === "current" ? s.inCurrentInput : s.inCandidateInput;
    const retained = (s: EvidenceScore) => arm === "current" ? s.retainedCurrent : s.retainedCandidate;
    lines.push(`${arm} input: ${all.filter(input).length} / ${all.length}; middle input: ${middle.filter(input).length} / ${middle.length}`, `${arm} retained: ${all.filter(retained).length} / ${all.length}; middle retained: ${middle.filter(retained).length} / ${middle.length}`);
  }
  for (const kind of ["scanner-missed", "model-dropped"]) lines.push(`candidate ${kind}: ${all.filter(s => s.attribution === kind).length} / ${all.length}; middle: ${middle.filter(s => s.attribution === kind).length} / ${middle.length}`);
  const selection = result.rows.flatMap(r => r.selection);
  const saturation = result.rows.reduce((n, row) => n + row.scores.filter(s => s.attribution === "scanner-missed" && row.selection.some(stat => stat.budgetExhausted && (s.resultIndexes ?? [s.resultIndex]).includes(stat.resultIndex))).length, 0);
  lines.push(`Results with K > 0: ${selection.length}; budgetExhausted: ${selection.filter(s => s.budgetExhausted).length}`, `scanner-missed in saturated results: ${saturation} / ${all.length}`, "\n## Totals", `Oracle retained current: ${all.filter(s => s.retainedCurrent).length} / ${all.length}; candidate: ${all.filter(s => s.retainedCandidate).length} / ${all.length}`);
  for (const verdict of ["candidate better", "same", "current better", "skipped", "error"]) lines.push(`judge ${verdict}: ${result.rows.filter(r => r.judge.verdict === verdict).length}`);
  for (const model of meta.models) for (const arm of ["current", "candidate"] as const) lines.push(`${model} / ${arm}: ${outcomeCounts(result.rows.filter(r => r.model === model).map(r => r[arm]))}`);
  return lines.join("\n\n") + "\n";
}
function detailRow(row: ReplayRow, score?: EvidenceScore): string {
  return `| ${[row.stem, row.batchIndex, row.model, score?.resultLength, score?.text.slice(0, 200), score?.inMiddle, score?.attribution, row.judge.verdict, row.judge.reason].map(cell).join(" | ")} |`;
}
function outcomeCounts(arms: Arm[]): string {
  return ["retained", "rejected-oversized", "unusable:empty", "unusable:length", "unusable:timeout", "error"].map(outcome => `${outcome}: ${arms.filter(a => a.outcome === outcome).length}`).join(", ");
}
function measurements(attempts: Attempt[]): string {
  const records = attempts.flatMap(a => a.records);
  const total = (key: "input" | "output" | "cost") => {
    const values = records.map(r => r.measurements[key]);
    if (!values.length || attempts.some(a => !a.records.length) || values.some(v => !v || v.provenance === "unavailable")) return "unavailable";
    return `${values.reduce((n, v) => n + v.value!, 0)} (${values.some(v => v.provenance === "estimated") ? "estimated" : "measured"})`;
  };
  return `input tokens: ${total("input")}; output tokens: ${total("output")}; elapsed ms: ${attempts.reduce((n, a) => n + a.elapsedMs, 0)}; cost: ${total("cost")}; attempts: ${attempts.length}`;
}
