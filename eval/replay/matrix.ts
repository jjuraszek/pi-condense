import type { ReplayResult } from "./run.js";
import { elapsedPercentile } from "./report.js";

export type ReplayJobs = ReplayResult & { models: string[]; thinking: string };
const cell = (value: unknown) => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");

export function replayMatrix(cells: { label: string; jobs: ReplayJobs }[]): string {
  const lines = ["| model | thinking | arm | retained/total | middle retained/total | regressions | gains | judge cand/same/cur | outcome errors | p50 ms | p95 ms | cost USD | mean chars |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const { jobs } of cells) for (const model of jobs.models) {
    const rows = jobs.rows.filter(row => row.model === model);
    const scores = rows.flatMap(row => row.scores), middle = scores.filter(score => score.inMiddle);
    for (const arm of ["current", "candidate"] as const) {
      const arms = rows.map(row => row[arm]), attempts = arms.flatMap(a => a.attempts);
      const retained = arms.filter(a => a.outcome === "retained");
      const kept = (s: typeof scores[number]) => arm === "current" ? s.retainedCurrent : s.retainedCandidate;
      const costs = attempts.flatMap(a => a.records.map(r => r.measurements.cost));
      const cost = !costs.length || attempts.some(a => !a.records.length) || costs.some(c => c.provenance === "unavailable") ? "unavailable" : `${costs.reduce((n, c) => n + c.value!, 0)} (${costs.some(c => c.provenance === "estimated") ? "estimated" : "measured"})`;
      lines.push(`| ${[
        model + (jobs.incomplete ? " (INCOMPLETE)" : ""), jobs.thinking, arm,
        `${scores.filter(kept).length} / ${scores.length}`, `${middle.filter(kept).length} / ${middle.length}`,
        arm === "current" ? "-" : scores.filter(s => s.retainedCurrent && !s.retainedCandidate).length,
        arm === "current" ? "-" : scores.filter(s => !s.retainedCurrent && s.retainedCandidate).length,
        arm === "current" ? "-" : ["candidate better", "same", "current better"].map(v => rows.filter(r => r.judge.verdict === v).length).join(" / "),
        arms.filter(a => a.outcome === "error").length,
        elapsedPercentile(attempts, .5), elapsedPercentile(attempts, .95), cost,
        retained.length ? retained.reduce((n, a) => n + (a.text?.length ?? 0), 0) / retained.length : 0,
      ].map(cell).join(" | ")} |`);
    }
  }
  return lines.join("\n") + "\n";
}
