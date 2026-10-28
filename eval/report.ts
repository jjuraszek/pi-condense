import { stableHash } from "./config";
import { sumMeasurements, type Measurement, type Measurements } from "./observer";
import type { Scenario } from "./scenario";

export interface Report {
  key: Record<string, string | number>;
  versions: Record<string, string>;
  revision: string;
  date: string;
  settings: unknown;
  scenarios: Scenario[];
  jobs: any[];
  estimate?: string;
  change?: string;
}
const escape = (s: unknown) => String(s ?? "").replace(/[&<>|`*_\[\]\\]/g, c => `&#${c.charCodeAt(0)};`).replace(/\r?\n/g, "<br>");
export function measurement(m?: Measurement): string {
  return !m || m.provenance === "unavailable" ? "unavailable" : `${m.value}${m.provenance === "estimated" ? " (estimated)" : ""}`;
}
const numeric = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? String(n) : "unavailable";
const passes = (r: Report, id: string) => r.jobs.filter(j => j.scenario === id && j.status === "ok" && j.verdict === "pass").length;
export const hasErrors = (r: Report) => r.jobs.some(j => j.status !== "ok" || j.verdict === "error");
function toolOutcome(t: any): string {
  if (t.outcome) return typeof t.outcome === "string" ? t.outcome : JSON.stringify(t.outcome);
  if (!t.result) return "no-result";
  if (t.name !== "context_tree_query") return "completed";
  if (/^\(not found in index\b/m.test(t.result)) return "not-found";
  return /^## toolRef: /m.test(t.result) ? "returned-source" : "wrong-source";
}
function safeJob(j: any) {
  return { scenario: j.scenario, runIndex: j.runIndex, status: j.status, verdict: j.verdict, errorReason: j.errorReason, check: j.check, reason: j.reason, recovery: j.recovery, reply: (j.reply ?? "").slice(0, 600), toolCalls: [...(j.toolCalls ?? [])].sort((a, b) => a.index - b.index).map((t: any) => ({ name: t.name, arguments: t.arguments, index: t.index, outcome: toolOutcome(t) })), usage: j.usage, callCounts: j.callCounts, elapsedMs: j.elapsedMs, attempts: j.attempts, backoffMs: j.backoffMs, retryOverhead: j.retryOverhead, judgeOverhead: j.judgeOverhead };
}
export function header(r: Report): string {
  return `# Behavioral context-retention eval\n\nThis paid eval measures what an assistant still does correctly after real summarization and pruning. Mechanical evidence gates and a frozen LLM judge score downstream behavior.\n\nComparison key: ${escape(JSON.stringify(r.key))}\n\nVersions: ${escape(JSON.stringify(r.versions))}\n\nRevision / corpus revision: ${escape(r.revision)}; corpus hash: ${escape(r.key.corpusHash)}\n\nDate: ${escape(r.date)}\n\nScoring: mechanical gate, then judge on judged cases; judge prompt hash ${escape(r.key.judgePromptHash)}.\n\nRetry policy: terminal provider HTTP 429 or transport only; delays 2000ms, 8000ms; retries: ${r.jobs.reduce((n, j) => n + (j.attempts ?? 1) - 1, 0)}.\n\nEstimated cost / duration: ${escape(r.estimate ?? "unavailable (no baseline yet)")}\n\nPipeline settings: ${escape(JSON.stringify(r.settings))}\n\nIntended change: ${escape(r.change ?? "baseline capture")} (follow the [behavioral-eval guidance](../../AGENTS.md#behavioral-eval)).\n`;
}
function usageRow(label: string, usage?: Measurements, elapsed?: number): string {
  return `| ${label} | ${measurement(usage?.input)} | ${measurement(usage?.output)} | ${numeric(elapsed)} | ${measurement(usage?.cost)} |`;
}
export function renderReport(r: Report): string {
  const safe = { ...r, scenarios: r.scenarios.map(({ id, title, tests, mechanical, judged }) => ({ id, title, tests, mechanical, judged })), jobs: r.jobs.map(safeJob) };
  let out = header(r);
  for (const s of r.scenarios) {
    const jobs = r.jobs.filter(j => j.scenario === s.id);
    const expected = s.judged ? `${s.judged.oracle} Expected: ${s.judged.expected}` : `The reply must contain ${(s.mechanical.contains ?? []).join(", ") || "the required answer"} and recover ${(s.mechanical.recovers ?? []).map(x => `${x.id}: ${x.evidence}`).join(", ") || "no additional sources"}.`;
    out += `\n## ${escape(s.title)}\n\n${escape(s.tests)}\n\n${escape(expected)}\n\npasses ${passes(r, s.id)}/${r.key.runs ?? r.key.RUNS_PER_CASE}, errors ${jobs.filter(j => j.status !== "ok" || j.verdict === "error").length}\n`;
    for (const j of jobs) {
      out += `\n### Repeat ${j.runIndex + 1}: ${escape(j.verdict)}\n\nCheck: ${escape(j.check)}; reason: ${escape(j.reason ?? j.errorReason)}\n\nRecovery: ${escape(JSON.stringify(j.recovery ?? []))}\n\nReply: ${escape((j.reply ?? "").slice(0, 600))}\n\nTools:\n`;
      for (const t of [...(j.toolCalls ?? [])].sort((a, b) => a.index - b.index)) out += `\n- ${escape(t.name)}(${escape(JSON.stringify(t.arguments))}) -> ${escape(toolOutcome(t))}\n`;
      out += `\nAttempts: ${j.attempts ?? 1}; backoff ms: ${j.backoffMs ?? 0}\n\n| Phase | Input tokens | Output tokens | Elapsed ms | Cost |\n|---|---|---|---|---|\n`;
      out += [usageRow("summarizer", j.usage?.summarizer, j.elapsedMs?.flush), usageRow("subject", j.usage?.subject, j.elapsedMs?.probe), usageRow("judge overhead", j.judgeOverhead?.usage, j.judgeOverhead?.elapsedMs), usageRow("retry overhead", j.retryOverhead?.usage, j.retryOverhead?.elapsedMs), usageRow("total", jobTotal(j), j.elapsedMs?.total)].join("\n") + "\n";
    }
  }
  out += `\n## Totals\n\n| Phase | Input tokens | Output tokens | Elapsed ms | Cost |\n|---|---|---|---|---|\n${usageRow("all jobs", sumMeasurements(r.jobs.map(jobTotal)), totalTime(r))}\n`;
  // JSON is encoded so report text cannot terminate the metadata container.
  return out + `\n<!-- pi-condense-eval:v1:${Buffer.from(JSON.stringify(safe)).toString("base64")} -->\n`;
}
const unavailable = () => sumMeasurements([]);
export function jobTotal(j: any): Measurements {
  const values: Measurements[] = [];
  for (const phase of ["subject", "summarizer"] as const) {
    if (j.callCounts?.[phase] !== 0) values.push(j.usage?.[phase] ?? unavailable());
  }
  if (j.judgeOverhead && (j.callCounts?.judge ?? j.judgeOverhead.calls) !== 0) values.push(j.judgeOverhead.usage);
  if (j.retryOverhead && j.attempts > 1) values.push(j.retryOverhead.usage);
  return sumMeasurements(values);
}
function totalTime(r: Report): number | undefined {
  return r.jobs.every(j => Number.isFinite(j.elapsedMs?.total)) ? r.jobs.reduce((n, j) => n + j.elapsedMs.total, 0) : undefined;
}
export function baselineEstimate(r: Report): string {
  return `${measurement(sumMeasurements(r.jobs.map(jobTotal)).cost)} / ${numeric(totalTime(r))} ms`;
}
export function readReport(md: string): Report {
  const match = md.match(/<!-- pi-condense-eval:v1:([A-Za-z0-9+/=]+) -->/);
  if (!match) throw Error("Missing or unsupported baseline metadata; run npm run eval -- --baseline");
  const decoded = JSON.parse(Buffer.from(match[1], "base64").toString());
  if (!decoded || typeof decoded !== "object" || !decoded.key || !decoded.versions || !Array.isArray(decoded.scenarios) || !Array.isArray(decoded.jobs)) throw Error("Invalid baseline metadata; run npm run eval -- --baseline");
  return decoded;
}
export function validateBaseline(r: Report, expected: Scenario[]): void {
  const invalid = () => { throw Error("Invalid baseline: require every scenario/repetition exactly once, valid verdicts, and no errors; run npm run eval -- --baseline"); };
  const runs = r.key?.RUNS_PER_CASE ?? r.key?.runs;
  if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs < 1 || !Array.isArray(r.scenarios) || !Array.isArray(r.jobs)) invalid();
  const ids = new Set(expected.map(s => s.id));
  if (r.scenarios.length !== ids.size || new Set(r.scenarios.map(s => s?.id)).size !== ids.size || r.scenarios.some(s => !s || !ids.has(s.id))) invalid();
  const seen = new Set<string>();
  for (const j of r.jobs) {
    if (!j || !ids.has(j.scenario) || !Number.isSafeInteger(j.runIndex) || j.runIndex < 0 || j.runIndex >= Number(runs) || j.status !== "ok" || !["pass", "fail"].includes(j.verdict) || j.errorReason) invalid();
    const key = JSON.stringify([j.scenario, j.runIndex]);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  if (seen.size !== ids.size * Number(runs)) invalid();
}
export function assertCompatible(a: Report, b: Report): string {
  if (stableHash(a.key) !== stableHash(b.key)) throw Error(`Comparison key mismatch\nBaseline:\n${header(a)}\nCandidate:\n${header(b)}`);
  return stableHash(a.versions) !== stableHash(b.versions) ? `WARNING: SDK versions differ: ${JSON.stringify(a.versions)} -> ${JSON.stringify(b.versions)}` : "";
}
function delta(a?: Measurement, b?: Measurement): string {
  return !a || !b || a.provenance === "unavailable" || b.provenance === "unavailable" ? "unavailable" : measurement({ value: b.value - a.value, provenance: a.provenance === "estimated" || b.provenance === "estimated" ? "estimated" : "measured" });
}
export function compareReports(a: Report, b: Report, change: string) {
  let text = `${assertCompatible(a, b)}\nChange: ${escape(change)}\n`;
  let dropped = false;
  for (const s of b.scenarios) {
    const before = passes(a, s.id), after = passes(b, s.id), runs = b.key.runs ?? b.key.RUNS_PER_CASE;
    text += `${s.id}: baseline ${before}/${runs} -> candidate ${after}/${runs} ${after === before ? "=" : after > before ? "+" : "-"}\n`;
    if (after < before) { dropped = true; text += `REGRESSION CANDIDATE: ${s.id} ${before}/${runs} -> ${after}/${runs}\n`; }
    for (const j of b.jobs.filter(j => j.scenario === s.id)) {
      const old = a.jobs.find(k => k.scenario === s.id && k.runIndex === j.runIndex);
      for (const field of ["check", "reason", "recovery"]) if (JSON.stringify(old?.[field]) !== JSON.stringify(j[field])) text += `Repeat ${j.runIndex + 1} ${field}: ${escape(JSON.stringify(old?.[field]))} -> ${escape(JSON.stringify(j[field]))}\n`;
      const at = old ? jobTotal(old) : undefined, bt = jobTotal(j);
      text += `Repeat ${j.runIndex + 1} overhead input ${delta(at?.input, bt.input)}, output ${delta(at?.output, bt.output)}, cost ${delta(at?.cost, bt.cost)}, elapsed ${Number.isFinite(old?.elapsedMs?.total) && Number.isFinite(j.elapsedMs?.total) ? j.elapsedMs.total - old.elapsedMs.total : "unavailable"} ms\n`;
      for (const field of ["judgeOverhead", "retryOverhead"]) text += `${field}: cost ${delta(old?.[field]?.usage?.cost, j[field]?.usage?.cost)}; elapsed ${Number.isFinite(old?.[field]?.elapsedMs) && Number.isFinite(j[field]?.elapsedMs) ? j[field].elapsedMs - old[field].elapsedMs : "unavailable"} ms\n`;
    }
  }
  const errors = b.jobs.filter(j => j.status !== "ok" || j.verdict === "error");
  text += `Errors: ${errors.length}\n${errors.map(j => `${j.scenario} repeat ${j.runIndex + 1}: ${j.errorReason ?? j.reason}`).join("\n")}\n`;
  return { text, exitCode: dropped || errors.length ? 1 : 0 };
}
