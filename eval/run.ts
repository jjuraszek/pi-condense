import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ModelRuntime, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, SUMMARIZER_MODELS, JUDGE_MODEL, RUNS_PER_CASE, PIPELINE_SETTINGS, RETRY_POLICY, concurrency, settingsHash, subjectPromptHash, corpusHash } from "./config";
import { judgePromptHash } from "./judge";
import { observe, sumMeasurements } from "./observer";
import { renderReport, readReport, validateBaseline, assertCompatible, compareReports, header, hasErrors, baselineEstimate, type Report } from "./report";
import type { Scenario } from "./scenario";

const help = 'Usage: npm run eval -- --change "<what changed>"\n       npm run eval -- --baseline\nOptions: --compare --change <text>, --baseline, --summarizer <id>, --runs <n>; EVAL_CONCURRENCY sets the positive pool limit.';
export function parseArgs(args: string[], env: Record<string, string | undefined> = process.env) {
  let baseline = false, compare = false, change = "", runs = RUNS_PER_CASE, selected: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw Error(`Duplicate flag ${flag}\n${help}`);
    seen.add(flag);
    if (flag === "--baseline") baseline = true;
    else if (flag === "--compare") compare = true;
    else if (["--change", "--runs", "--summarizer"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error(`Missing value for ${flag}\n${help}`);
      if (flag === "--change") change = value.trim();
      if (flag === "--runs") { if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error("--runs must be a positive integer"); runs = Number(value); }
      if (flag === "--summarizer") selected = value;
    } else throw Error(`Unknown flag ${flag}\n${help}`);
  }
  if ((baseline && (compare || seen.has("--change"))) || (!baseline && !change)) throw Error(help);
  if (baseline && runs !== RUNS_PER_CASE) throw Error(`--baseline requires --runs ${RUNS_PER_CASE}`);
  if (selected && !SUMMARIZER_MODELS.includes(selected as any)) throw Error(`Unknown summarizer ${selected}`);
  return { mode: baseline ? "baseline" as const : "compare" as const, change, runs, summarizers: selected ? [selected] : [...SUMMARIZER_MODELS], concurrency: concurrency(env) };
}
interface PreflightSeams {
  git(args: string[]): Promise<string>;
  operatorDir(): string;
  runtime(dir: string): Promise<{ getModel(provider: string, id: string): unknown; hasConfiguredAuth(provider: string): boolean }>;
}
export async function preflight(seams: PreflightSeams, summarizers: string[]) {
  const status = await seams.git(["status", "--porcelain"]);
  if (status.trim()) throw Error(`Dirty working tree; no eval setup performed:\n${status}`);
  const revision = (await seams.git(["rev-parse", "HEAD"])).trim();
  const operatorAgentDir = seams.operatorDir();
  const runtime = await seams.runtime(operatorAgentDir);
  for (const name of new Set([SUBJECT_MODEL, JUDGE_MODEL, ...SUMMARIZER_MODELS, ...summarizers])) {
    const [provider, id] = name.split("/");
    if (!runtime.getModel(provider, id) || !runtime.hasConfiguredAuth(provider)) throw Error(`Missing or unauthenticated model ${name}; check pi --list-models`);
  }
  return { revision, operatorAgentDir };
}
export async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error("Pool limit must be positive");
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i], i); }
  }));
  return results;
}
export async function retryJob(base: string, run: (dir: string) => Promise<any>, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
  const history: any[] = [];
  let backoffMs = 0;
  for (let attempt = 0; ; attempt++) {
    const result = await run(`${base}/attempt-${attempt + 1}`);
    const terminal = result.records?.at(-1);
    const retry = terminal?.retry;
    const forbidden = ["error:summarizer", "error:summarizer-fallback", "error:isolation", "error:extension", "error:no-flush", "error:not-pruned"];
    const retryable = result.status === "error" && !forbidden.includes(result.errorReason) && terminal?.phase !== "summarizer" && terminal?.status !== "ok" && retry?.retryable === true && (retry.kind === "transport" || (retry.kind === "http" && retry.httpStatus === 429));
    if (!retryable || attempt === RETRY_POLICY.retries) {
      const wasted = history.flatMap(j => j.records ?? []);
      return { ...result, ...(retryable ? { errorReason: "error:provider", reason: "error:provider" } : {}), attempts: attempt + 1, backoffMs,
        elapsedMs: { ...result.elapsedMs, total: [...history, result].every(j => Number.isFinite(j.elapsedMs?.total)) ? history.reduce((n, j) => n + j.elapsedMs.total, result.elapsedMs.total) + backoffMs : undefined },
        retryOverhead: { usage: sumMeasurements(wasted.map(r => r.measurements)), elapsedMs: history.every(j => Number.isFinite(j.elapsedMs?.total)) ? history.reduce((n, j) => n + j.elapsedMs.total, 0) + backoffMs : undefined, attempts: history.map((j, i) => ({ path: `${base}/attempt-${i + 1}`, status: j.status, errorReason: j.errorReason, elapsedMs: j.elapsedMs, usage: j.usage, judgeOverhead: j.judgeOverhead })) } };
    }
    history.push(result);
    const delay = RETRY_POLICY.backoffMs[attempt];
    backoffMs += delay;
    await sleep(delay);
  }
}
const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export interface MainSeams extends PreflightSeams {
  repo: string;
  env: Record<string, string | undefined>;
  now(): Date;
  read(path: string): Promise<string>;
  files(path: string): Promise<string[]>;
  load(path: string): Promise<Scenario>;
  temp(): Promise<string>;
  mkdir(path: string): Promise<unknown>;
  write(path: string, text: string): Promise<unknown>;
  spawn(args: string[], env: Record<string, string | undefined>, cwd: string, logPath: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  versions(): Record<string, string>;
  print(text: string): void;
}
const defaults: MainSeams = {
  repo: repoDefault, env: process.env, operatorDir: getAgentDir,
  git: async args => { const p = Bun.spawn(["git", "-C", repoDefault, ...args], { stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); if (await p.exited) throw Error(await new Response(p.stderr).text()); return out; },
  runtime: async dir => {
    const credentials = new InMemoryCredentialStore();
    for (const provider of new Set([SUBJECT_MODEL, JUDGE_MODEL, ...SUMMARIZER_MODELS].map(id => id.split("/")[0]))) {
      const credential = readStoredCredential(provider, join(dir, "auth.json"));
      if (credential) await credentials.modify(provider, async () => credential);
    }
    return observe(await ModelRuntime.create({ credentials, modelsPath: join(dir, "models.json"), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false })).runtime;
  },
  now: () => new Date(), read: path => readFile(path, "utf8"), files: readdir,
  load: async path => (await import(path)).default,
  temp: () => mkdtemp(join(tmpdir(), "pi-condense-eval-")), mkdir: path => mkdir(path, { recursive: true }), write: writeFile,
  spawn: async (args, env, cwd, logPath) => {
    const log = Bun.file(logPath).writer();
    try { const p = Bun.spawn(args, { env, cwd, stdout: "pipe", stderr: "pipe" }); await Promise.all([new Response(p.stdout).arrayBuffer().then(b => log.write(b)), new Response(p.stderr).arrayBuffer().then(b => log.write(b)), p.exited]); } finally { await log.end(); }
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  versions: () => Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"].map(name => [name, JSON.parse(readFileSync(resolve(dirname(require.resolve(name)), "../package.json"), "utf8")).version])),
  print: console.log,
};
export const baselineName = (summarizer: string) => {
  if (!SUMMARIZER_MODELS.includes(summarizer as any)) throw Error("Invalid summarizer basename");
  return `${summarizer.split("/")[1]}.md`;
};
export async function main(args: string[], seams: MainSeams = defaults): Promise<number> {
  const options = parseArgs(args, seams.env);
  const { revision, operatorAgentDir } = await preflight(seams, options.summarizers);
  const scenarioDir = join(seams.repo, "eval/scenarios");
  const files = (await seams.files(scenarioDir)).filter(f => f.endsWith(".ts")).sort();
  const scenarios = await Promise.all(files.map(f => seams.load(join(scenarioDir, f))));
  const corpus = corpusHash(await Promise.all(files.map(async path => ({ path, bytes: await seams.read(join(scenarioDir, path)) }))));
  const versions = seams.versions(), date = seams.now().toISOString();
  const reports: Report[] = options.summarizers.map(summarizer => ({
    key: { SUBJECT_MODEL, subjectPromptHash: subjectPromptHash(), SUBJECT_THINKING_LEVEL, summarizer, JUDGE_MODEL, judgePromptHash: judgePromptHash(), settingsHash: settingsHash(), corpusHash: corpus, RUNS_PER_CASE: options.runs },
    versions, revision, date, scenarios, jobs: [], settings: { ...PIPELINE_SETTINGS, summarizerModel: summarizer }, change: options.change,
  }));
  const baselines = new Map<string, Report>();
  for (const r of reports) {
    const name = String(r.key.summarizer);
    let previous: Report | undefined;
    try { previous = readReport(await seams.read(join(seams.repo, "eval/baseline", baselineName(name)))); }
    catch (error) { if (options.mode === "compare") throw Error(`No readable baseline for ${name}; run npm run eval -- --baseline\n${String(error)}`); }
    if (previous) {
      if (options.mode === "compare") {
        const warning = assertCompatible(previous, r);
        if (warning) seams.print(warning);
        validateBaseline(previous, scenarios);
        baselines.set(name, previous);
        r.estimate = baselineEstimate(previous);
      } else {
        try {
          validateBaseline(previous, scenarios);
          r.estimate = baselineEstimate(previous);
        } catch { r.estimate = "unavailable (no baseline yet)"; }
      }
    }
    seams.print(header(r));
  }
  const root = await seams.temp();
  try {
    const jobs = reports.flatMap(r => scenarios.flatMap(scenario => Array.from({ length: options.runs }, (_, runIndex) => ({ summarizer: String(r.key.summarizer), scenario, runIndex }))));
    const results = await pool(jobs, options.concurrency, async (job, index) => {
      const result = await retryJob(join(root, `job-${index}`), async jobPath => {
        await seams.mkdir(jobPath);
        const env = { ...seams.env, PI_CODING_AGENT_DIR: join(jobPath, "agent") };
        try {
          await seams.spawn([process.execPath, join(seams.repo, "eval/session.ts"), job.scenario.id, job.summarizer, String(job.runIndex), jobPath, operatorAgentDir, seams.repo], env, jobPath, join(jobPath, "subprocess.log"));
          return JSON.parse(await seams.read(join(jobPath, "job.json")));
        } catch { return { status: "error", verdict: "error", errorReason: "error:job", reply: "", records: [] }; }
      }, seams.sleep);
      return { ...result, scenario: job.scenario.id, summarizer: job.summarizer, runIndex: job.runIndex };
    });
    for (const r of reports) r.jobs = results.filter(j => j.summarizer === r.key.summarizer);
    const rendered = reports.map(r => ({ report: r, text: renderReport(r) }));
    if (options.mode === "baseline" && reports.some(hasErrors)) { seams.print("Errored jobs: no baseline written."); return 1; }
    let exitCode = 0;
    for (const { report: r, text } of rendered) {
      const basename = baselineName(String(r.key.summarizer));
      const dir = options.mode === "baseline" ? join(seams.repo, "eval/baseline") : root;
      await seams.mkdir(dir);
      const path = join(dir, basename);
      await seams.write(path, text);
      seams.print(`Report: ${path}; retries: ${r.jobs.reduce((n, j) => n + j.attempts - 1, 0)}`);
      if (options.mode === "compare") { const comparison = compareReports(baselines.get(String(r.key.summarizer))!, r, options.change); seams.print(comparison.text); exitCode = Math.max(exitCode, comparison.exitCode); }
    }
    return exitCode;
  } finally {
    seams.print(`Retained evidence: ${root}`);
  }
}
if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
