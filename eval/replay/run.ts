import { ModelRuntime, ModelRegistry, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { runSummarization } from "../../src/summarizer.js";
import { ToolCallIndexer } from "../../src/indexer.js";
import { substituteInlineRefs, formatSummaryToolCallRefs } from "../../src/summary-refs.js";
import type { CapturedBatch } from "../../src/types.js";
import { observe, type CallRecord } from "../observer.js";
import { SUMMARIZER_MODELS, JUDGE_MODEL, PIPELINE_SETTINGS, RETRY_POLICY } from "../config.js";
import { loadCandidate, productionArm, type ReplayArm } from "./candidate.js";
import { REPLAY_JUDGE_PROMPT } from "./judge-prompt.js";
import { assertOutsideRepo } from "./paths.js";
import { extractSessions, type ReplayCounts, type ReplaySession } from "./extract.js";
import { oracleCandidates, type OracleCandidate } from "./oracle.js";
import { replayMatrix, type ReplayJobs } from "./matrix.js";
import { renderReplayReport } from "./report.js";

export type Thinking = "default" | "off" | "low" | "medium" | "high";
export interface Options { corpus: string; out: string; limit?: number; models: string[]; thinking: Thinking; dryRun: boolean; candidate?: string }
export function parseArgs(args: string[]): Options {
  if (args[0] !== "run") throw Error("Usage: eval:replay run --corpus <dir> [--limit N] [--models a,b] [--thinking off|low|medium|high] [--out <dir>] [--candidate <module>] [--dry-run]");
  let out: string | undefined, candidate: string | undefined;
  let thinking: Thinking = PIPELINE_SETTINGS.summarizerThinking;
  let corpus = "", limit: number | undefined, models: string[] = [...SUMMARIZER_MODELS], dryRun = false;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw Error(`Duplicate flag ${flag}`);
    seen.add(flag);
    if (flag === "--dry-run") { dryRun = true; continue; }
    if (!["--corpus", "--limit", "--models", "--thinking", "--out", "--candidate"].includes(flag)) throw Error(`Unknown flag ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`Missing value for ${flag}`);
    if (flag === "--corpus") corpus = value;
    if (flag === "--out") out = value;
    if (flag === "--candidate") candidate = value;
    if (flag === "--thinking") {
      if (!["off", "low", "medium", "high"].includes(value)) throw Error("Invalid --thinking level");
      thinking = value as Thinking;
    }
    if (flag === "--limit") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error("--limit must be a positive integer");
      limit = Number(value);
    }
    if (flag === "--models") {
      models = value.split(",");
      if (new Set(models).size !== models.length || models.some(m => !/^[^\/\s]+\/[^\/\s]+$/.test(m))) throw Error("Models must be unique provider/id strings");
    }
  }
  if (!corpus) throw Error("--corpus is required");
  return { corpus, out: out ?? corpus, limit, models, thinking: thinking as Thinking, dryRun, candidate };
}

export interface SelectedBatch { stem: string; session: ReplaySession; batch: CapturedBatch; batchIndex: number; rawChars: number }
export interface ReplayPlan { thinking: Thinking; selected: SelectedBatch[]; models: string[]; eligible: number; skippedTrivial: number; skippedSpilled: number; summarizerCalls: number; judgeCalls: number }
export function planReplay(sessions: { stem: string; session: ReplaySession }[], models: string[], thinking: Thinking = PIPELINE_SETTINGS.summarizerThinking as Thinking, limit = Number.MAX_SAFE_INTEGER): ReplayPlan {
  const selected: SelectedBatch[] = [];
  let eligible = 0, skippedTrivial = 0, skippedSpilled = 0;
  for (const { stem, session } of [...sessions].sort((a, b) => a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)) {
    const ordered = session.batches.map((batch, batchIndex) => ({ batch, batchIndex })).sort((a, b) => a.batch.turnIndex - b.batch.turnIndex);
    for (const { batch, batchIndex } of ordered) {
      const positions = session.batchPositions[batchIndex].results;
      if (batch.toolCalls.length && batch.toolCalls.every((c, i) => !!c.spillPath || positions[i]?.spilled)) { skippedSpilled++; continue; }
      const rawChars = batch.toolCalls.reduce((n, c, i) => n + (c.spillPath || positions[i]?.spilled ? 0 : c.resultText.length), 0);
      if (PIPELINE_SETTINGS.minBatchChars > 0 && rawChars < PIPELINE_SETTINGS.minBatchChars && batch.toolCalls.length > 0) { skippedTrivial++; continue; }
      eligible++;
      if (selected.length < limit) selected.push({ stem, session, batch, batchIndex, rawChars });
    }
  }
  return { selected, models, thinking, eligible, skippedTrivial, skippedSpilled, summarizerCalls: selected.length * 2 * models.length, judgeCalls: selected.length * models.length };
}

export type Outcome = "retained" | "rejected-oversized" | "unusable:empty" | "unusable:length" | "unusable:timeout" | "error";
export interface Attempt { records: CallRecord[]; notifications: string[]; elapsedMs: number }
export interface Arm { outcome: Outcome; text?: string; attempts: Attempt[] }
export interface EvidenceScore extends OracleCandidate { inCurrentInput: boolean; inCandidateInput: boolean; retainedCurrent: boolean; retainedCandidate: boolean; attribution?: "not-in-input" | "model-dropped"; resultIndexes: number[] }
export interface Judge { verdict: "candidate better" | "same" | "current better" | "skipped" | "error"; reason?: string; attempts: Attempt[] }
export interface ReplayRow { stem: string; batchIndex: number; model: string; assignment: "candidate=A" | "candidate=B"; current: Arm; candidate: Arm; scores: EvidenceScore[]; judge: Judge }
export interface ReplayResult { rows: ReplayRow[]; incomplete: boolean; exitCode: 0 | 1 | 2 }
type Runtime = Pick<ModelRuntime, "getModel" | "hasConfiguredAuth" | "getAuth" | "streamSimple" | "completeSimple">;
type Sleep = (ms: number) => Promise<void>;
const sleepDefault: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = (records: CallRecord[]) => {
  const last = records.at(-1);
  return last?.status !== "ok" && last?.retry.retryable && (last.retry.kind === "transport" || (last.retry.kind === "http" && last.retry.httpStatus === 429));
};

export async function executeReplay(plan: ReplayPlan, original: Runtime, replayArms: { current: ReplayArm; candidate: ReplayArm }, sleep: Sleep = sleepDefault): Promise<ReplayResult> {
  const runtime = original;
  const candidatesBySession = new Map<ReplaySession, ReturnType<typeof oracleCandidates>>();
  const modelRegistry = new ModelRegistry(runtime as ModelRuntime);
  const models = new Map<string, NonNullable<ReturnType<Runtime["getModel"]>>>();
  for (const name of new Set([...plan.models, JUDGE_MODEL])) {
    const [provider, id] = name.split("/");
    const model = runtime.getModel(provider, id);
    if (!model || !runtime.hasConfiguredAuth(provider)) throw Error(`Missing or unauthenticated model ${name}`);
    // Resolve physical-model credentials before spending on any other model.
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw Error(`Missing or unauthenticated model ${name}`);
    models.set(name, model);
  }
  const rows: ReplayRow[] = [];
  for (const selected of plan.selected) {
    const { session, stem, batchIndex, rawChars } = selected;
    // Persisted spill metadata is authoritative, even for hand-built envelopes.
    const batch = { ...selected.batch, toolCalls: selected.batch.toolCalls.map((c, i) => c.spillPath || session.batchPositions[batchIndex].results[i]?.spilled ? { ...c, resultText: "" } : c) };
    const inputs = { current: replayArms.current.serialize(batch), candidate: replayArms.candidate.serialize(batch) };
    if (!candidatesBySession.has(session)) candidatesBySession.set(session, oracleCandidates(session));
    const candidates = candidatesBySession.get(session)!.get(batchIndex)!;
    const strings = new Set(candidates.map(c => c.text));
    for (const name of plan.models) {
      const arms = {} as Record<"current" | "candidate", Arm>;
      for (const arm of ["current", "candidate"] as const) {
        const attempts: Attempt[] = [];
        let outcome: Outcome = "error", text: string | undefined;
        for (let attempt = 0; ; attempt++) {
          const observer = observe(original);
          observer.setPhase("summarizer");
          const attemptRegistry = new ModelRegistry(observer.runtime as ModelRuntime);
          const started = performance.now(), notifications: string[] = [];
          let result = null;
          try {
            result = await runSummarization(`${replayArms[arm].systemPrompt}\n\n<tool-call-batch>\n${inputs[arm]}\n</tool-call-batch>`, { ...PIPELINE_SETTINGS, summarizerModel: name, summarizerThinking: plan.thinking, protectedTools: [...PIPELINE_SETTINGS.protectedTools], protectedPaths: [...PIPELINE_SETTINGS.protectedPaths] }, { model: models.get(name), modelRegistry: attemptRegistry, ui: { notify: (message: string) => notifications.push(message) } } as any, { signal: new AbortController().signal });
          } catch {
            // Observer metadata, not the thrown message, owns provider attribution.
          }
          // Snapshot completed measurements; an empty snapshot means unavailable, not zero.
          const records = observer.records.slice();
          attempts.push({ records, notifications, elapsedMs: performance.now() - started });
          if (result) {
            const refs = new ToolCallIndexer().allocateSummaryRefs(batch);
            const decorated = substituteInlineRefs(result.summaryText, refs, batch.toolCalls.map(c => c.toolName)) + formatSummaryToolCallRefs(refs);
            outcome = decorated.length > rawChars ? "rejected-oversized" : "retained";
            if (outcome === "retained") text = decorated;
          } else if (notifications.some(n => n.startsWith("pi-condense: summarizer ") && n.endsWith("; summarizer call abandoned"))) outcome = "unusable:timeout";
          else if (records.at(-1)?.status === "ok" && records.at(-1)?.response?.stopReason === "length") outcome = "unusable:length";
          else if (records.at(-1)?.status === "ok" && !records.at(-1)?.response?.text.trim()) outcome = "unusable:empty";
          if (outcome !== "error" || !retryable(records) || attempt >= RETRY_POLICY.retries) break;
          await sleep(RETRY_POLICY.backoffMs[attempt]);
        }
        arms[arm] = { outcome, ...(text !== undefined ? { text } : {}), attempts };
      }
      const scores: EvidenceScore[] = [...strings].map(text => {
        const provenance = candidates.filter(c => c.text === text);
        // A batch string is middle-only only when no result exposes it in head/tail.
        const first = provenance[0];
        const retainedCandidate = arms.candidate.outcome === "retained" && arms.candidate.text!.includes(text);
        const inCandidateInput = inputs.candidate.includes(text);
        return { ...first, inMiddle: provenance.every(c => c.inMiddle), resultIndexes: provenance.map(c => c.resultIndex), inCurrentInput: inputs.current.includes(text), inCandidateInput, retainedCurrent: arms.current.outcome === "retained" && arms.current.text!.includes(text), retainedCandidate, ...(!retainedCandidate ? { attribution: inCandidateInput ? "model-dropped" as const : "not-in-input" as const } : {}) };
      });
      const assignment = rows.length % 2 === 0 ? "candidate=A" as const : "candidate=B" as const;
      const judge: Judge = { verdict: "skipped", attempts: [] };
      if (arms.current.outcome === "retained" && arms.candidate.outcome === "retained") {
        const observer = observe(original);
        observer.setPhase("judge");
        judge.verdict = "error";
        let providerFailed = false;
        for (let malformed = 0; malformed < 2; malformed++) {
          let answer;
          for (let attempt = 0; ; attempt++) {
            const start = observer.records.length, started = performance.now();
            try {
              answer = await observer.runtime.completeSimple(models.get(JUDGE_MODEL)!, { systemPrompt: REPLAY_JUDGE_PROMPT, messages: [{ role: "user", timestamp: 0, content: JSON.stringify({ batch: inputs.candidate, A: assignment === "candidate=A" ? arms.candidate.text : arms.current.text, B: assignment === "candidate=B" ? arms.candidate.text : arms.current.text }) }] });
            } catch { answer = undefined; }
            const records = observer.records.slice(start);
            judge.attempts.push({ records, notifications: [], elapsedMs: performance.now() - started });
            providerFailed = !answer || answer.stopReason === "error" || answer.stopReason === "aborted";
            if (!providerFailed || !retryable(records) || attempt >= RETRY_POLICY.retries) break;
            await sleep(RETRY_POLICY.backoffMs[attempt]);
          }
          if (providerFailed) break;
          try {
            const text = answer!.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
            const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
            const verdict = JSON.parse(fenced ? fenced[1] : text);
            if (!["A better", "same", "B better"].includes(verdict?.verdict) || typeof verdict.reason !== "string" || !verdict.reason.trim() || /[\r\n]/.test(verdict.reason)) continue;
            judge.verdict = verdict.verdict === "same" ? "same" : (verdict.verdict === "A better") === (assignment === "candidate=A") ? "candidate better" : "current better";
            judge.reason = verdict.reason;
            break;
          } catch { /* Re-ask a malformed verdict once, independently of provider retries. */ }
        }
      }
      rows.push({ stem, batchIndex, model: name, assignment, ...arms, scores, judge });
    }
  }
  const incomplete = rows.some(r => r.current.outcome === "error" || r.candidate.outcome === "error" || r.judge.verdict === "error");
  const regressions = rows.some(r => r.scores.some(s => s.retainedCurrent && !s.retainedCandidate));
  return { rows, incomplete, exitCode: incomplete ? 1 : regressions ? 2 : 0 };
}

async function storedRuntime(models: string[]): Promise<Runtime> {
  const dir = getAgentDir(), credentials = new InMemoryCredentialStore();
  for (const provider of new Set([...models, JUDGE_MODEL].map(m => m.split("/")[0]))) {
    const credential = readStoredCredential(provider, join(dir, "auth.json"));
    if (credential) await credentials.modify(provider, async () => credential);
  }
  return ModelRuntime.create({ credentials, modelsPath: join(dir, "models.json"), modelsStore: new InMemoryModelsStore(), allowModelNetwork: true });
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function replayMain(args: string[], seams: { runtime?: () => Promise<Runtime>; print?: (text: string) => void; sleep?: Sleep } = {}): Promise<number> {
  const print = seams.print ?? console.log;
  if (args[0] === "extract") {
    if (!args[1] || (args.length !== 2 && (args.length !== 4 || args[2] !== "--out"))) throw Error("Usage: extract <session-dir> [--out <dir>]");
    print(JSON.stringify(extractSessions(args[1], args[3]))); return 0;
  }
  if (args[0] === "matrix") {
    if (args.length < 2) throw Error("Usage: matrix <jobs.json> [<jobs.json>...]");
    print(replayMatrix(args.slice(1).map(file => {
      const jobs: ReplayJobs = JSON.parse(readFileSync(assertOutsideRepo(file), "utf8"));
      return { label: `${jobs.models[0]} ${jobs.thinking}`, jobs };
    })));
    return 0;
  }
  const options = parseArgs(args), corpus = assertOutsideRepo(options.corpus), out = assertOutsideRepo(options.out);
  let loaded;
  try { loaded = await loadCandidate(options.candidate, process.cwd()); }
  catch (error) { print(error instanceof Error ? error.message : String(error)); return 1; }
  const { name: candidateName, arm: candidate } = loaded;
  mkdirSync(out, { recursive: true });
  const sessions: { stem: string; session: ReplaySession }[] = [];
  const counts: ReplayCounts = { sessionsRead: 0, sessionsSkipped: 0, batches: 0, longResults: 0, spillPresent: 0, spillMissing: 0, protectedExclusions: 0 };
  for (const file of readdirSync(corpus).filter(f => f.endsWith(".json") && f !== "jobs.json").sort()) {
    let value;
    try { value = JSON.parse(readFileSync(join(corpus, file), "utf8")); } catch { counts.sessionsSkipped++; continue; }
    if (!value || !Array.isArray(value.batches) || !Array.isArray(value.messages) || !Array.isArray(value.batchPositions) || !value.counts) continue;
    sessions.push({ stem: basename(file, ".json"), session: value });
    for (const key of Object.keys(counts) as (keyof ReplayCounts)[]) counts[key] += value.counts[key] ?? 0;
  }
  const plan = planReplay(sessions, options.models, options.thinking, options.limit);
  print(JSON.stringify({ ...counts, candidate: candidateName, eligible: plan.eligible, selected: plan.selected.length, skippedTrivial: plan.skippedTrivial, skippedSpilled: plan.skippedSpilled, models: plan.models, thinking: plan.thinking, summarizerCalls: plan.summarizerCalls, judgeCalls: plan.judgeCalls }));
  if (options.dryRun) return 0;
  let result: ReplayResult;
  try { result = await executeReplay(plan, await (seams.runtime ? seams.runtime() : storedRuntime(options.models)), { current: productionArm, candidate }, seams.sleep); }
  catch { result = { rows: [], incomplete: true, exitCode: 1 }; }
  const metadata = { corpus, counts, eligible: plan.eligible, selected: plan.selected.length, skippedTrivial: plan.skippedTrivial, skippedSpilled: plan.skippedSpilled, models: plan.models, thinking: plan.thinking, candidate: candidateName, hashes: { current: hash(productionArm.systemPrompt), candidate: hash(candidate.systemPrompt), rubric: hash(REPLAY_JUDGE_PROMPT) } };
  writeFileSync(assertOutsideRepo(join(out, "jobs.json")), JSON.stringify({ ...metadata, ...result }, null, 2));
  writeFileSync(assertOutsideRepo(join(out, "report.md")), renderReplayReport(result, metadata));
  return result.exitCode;
}
if (import.meta.main) {
  replayMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { console.error("Replay refused or failed; no private content printed"); process.exitCode = 1; });
}
