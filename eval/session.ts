import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { IDLE_PIPELINE_SETTINGS, PIPELINE_SETTINGS, SUBJECT_MODEL, SUBJECT_SYSTEM_PROMPT, SUBJECT_THINKING_LEVEL, SUMMARIZER_MODELS } from "./config.js";
import { isProtected } from "../src/protected.js";
import { detectChains } from "../src/chain-detector.js";
import { seedEntries, type Scenario } from "./scenario.js";
import { observe, classifySummarizer, sumMeasurements, type CallRecord } from "./observer.js";
import { buildShortRefMap, score, type ToolObservation, type Recovery } from "./judge.js";

export interface JobOptions {
  scenario: Scenario;
  summarizer: string;
  runIndex: number;
  jobPath: string;
  operatorAgentDir: string;
  repo: string;
  suite?: "standard" | "idle";
  runtime?: ModelRuntime;
  /** Offline negative control; CLI jobs always use the full pinned settings. */
  settings?: { enabled: false };
}

class JobError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
const text = (content: any): string => typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const requireProof = (condition: unknown, reason: string) => { if (!condition) throw new JobError(reason); };

function idleCalls(scenario: Scenario) {
  return scenario.history.flatMap(turn => turn.role === "assistant" ? turn.toolCalls ?? [] : []).map(call => ({
    ...call,
    kind: isProtected(call.name, call.arguments, IDLE_PIPELINE_SETTINGS) ? "protected" : scenario.unsummarizedIds?.includes(call.id) ? "unsummarized" : "summarized",
  }));
}

export function idleFlushIndexed(scenario: Scenario, refs: ReadonlyMap<string, string>): boolean {
  const indexed = new Set(refs.values());
  return idleCalls(scenario).every(call => indexed.has(call.id) === (call.kind === "summarized"));
}

export function assertIdleRequest({ scenario, seeded, branch, outgoing, refMap, summaries }: {
  scenario: Scenario; seeded: any[]; branch: any[]; outgoing: any[];
  refMap: ReadonlyMap<string, string>; summaries: { content: string }[];
}): void {
  const chains = branch.filter(e => e.type === "custom" && e.customType === "context-prune-chain").map(e => e.data)
    .filter(e => outgoing.some(m => text(m.content).startsWith(`<compressed-chain id="${e.blockId}"`)));
  const compressed = outgoing.some(m => text(m.content).startsWith("<compressed-chain"));
  const closed = detectChains(seeded).filter(c => c.finalAssistantTimestamp !== null);
  requireProof(scenario.twinOf ? closed.every(c => chains.some(e => e.startUserTimestamp === c.startUserTimestamp)) : !compressed, "error:idle-arm");
  const bodies = outgoing.map(m => text(m.content));
  requireProof(summaries.some(s => bodies.some(body => body.includes(s.content))), "error:not-pruned");
  for (const call of idleCalls(scenario)) {
    const raw = scenario.history.find(t => t.role === "result" && t.toolCallId === call.id);
    requireProof(raw?.role === "result", "error:not-pruned");
    const results = outgoing.filter(m => m.role === "toolResult" && m.toolCallId === call.id);
    const owningChain = chains.find(e => e.droppedToolCallIds.includes(call.id));
    const inside = owningChain !== undefined;
    const relocated = inside && bodies.some(body => body.startsWith(`<compressed-chain id="${owningChain.blockId}"`)
      && [...body.matchAll(/<protected-output(?:\s[^>]*)?>([\s\S]*?)<\/protected-output>/g)].some(block => block[1].includes(raw!.text!)));
    if (call.kind === "protected") requireProof(results.some(m => text(m.content) === raw!.text) || relocated, "error:not-pruned");
    else if (call.kind === "unsummarized") requireProof(inside
      ? results.length === 0 && relocated
      : results.some(m => text(m.content) === raw!.text), "error:not-pruned");
    else {
      requireProof(!bodies.some(body => body.includes(raw!.text!)), "error:not-pruned");
      requireProof(inside ? results.length === 0 : [...refMap].some(([ref, id]) => id === call.id && results.some(m => text(m.content) === `[Summarized in pruner summary, ref \`${ref}\`. Use context_tree_query to retrieve full output.]`)), "error:not-pruned");
    }
  }
}

export async function runJob(options: JobOptions) {
  const started = performance.now();
  const jobPath = resolve(options.jobPath);
  const agentDir = join(jobPath, "agent");
  const cwd = join(jobPath, "cwd");
  let session: AgentSession | undefined;
  let records: CallRecord[] = [];
  let flush = 0;
  let probe = 0;
  let reply = "";
  let toolCalls: ToolObservation[] = [];
  let recovery: Recovery[] = [];
  let finalAssistantIndex = -1;
  let verdict: string | undefined;
  let check: string | undefined;
  let reason: string | undefined;
  let errorReason: string | undefined;
  let summaries: { content: string; details: unknown }[] = [];
  let idleChainEntries: unknown[] = [];
  let shortRefs: [string, string][] = [];
  let flushMetrics: unknown[] = [];
  let extensionFailed = false;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    requireProof((await readdir(cwd)).length === 0, "error:isolation");
    requireProof(resolve(process.env.PI_CODING_AGENT_DIR ?? "") === agentDir, "error:isolation");
    requireProof(SUMMARIZER_MODELS.includes(options.summarizer as any), "error:isolation");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ contextPrune: { ...(options.suite === "idle" ? IDLE_PIPELINE_SETTINGS : PIPELINE_SETTINGS), summarizerModel: options.summarizer, ...options.settings } }));
    const original = options.runtime ?? await ModelRuntime.create({ authPath: join(options.operatorAgentDir, "auth.json"), modelsPath: join(options.operatorAgentDir, "models.json"), modelsStorePath: join(agentDir, "models-cache.json") });
    const observed = observe(original);
    records = observed.records;
    observed.setPhase("summarizer");
    // Agent requests carry the SDK's system message; extension summaries use a user-only context.
    // Route each invocation, since recovery can trigger another summary during the probe.
    const sessionRuntime = new Proxy(observed.runtime, {
      get(target, key) {
        if (key === "streamSimple" || key === "completeSimple") return (model: any, context: any, options: any) => {
          observed.setPhase(context.messages.some((m: any) => m.role === "system") ? "subject" : "summarizer");
          return target[key](model, context, options);
        };
        return Reflect.get(target, key);
      },
    });
    const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [join(options.repo, "index.ts")], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => SUBJECT_SYSTEM_PROMPT });
    await loader.reload();
    const loaded = loader.getExtensions();
    requireProof(!loaded.errors.length && loaded.extensions.length === 1 && resolve(loaded.extensions[0].resolvedPath) === resolve(options.repo, "index.ts"), "error:extension");
    const [provider, id] = SUBJECT_MODEL.split("/");
    const model = observed.runtime.getModel(provider, id);
    requireProof(model, "error:model");
    const seeded = seedEntries(options.scenario.history, Date.now() - (options.scenario.seedAgeMinutes ?? 0) * 60_000);
    const seedMessages = seeded.filter(e => e.type === "message").map(e => e.message);
    const manager = SessionManager.inMemory(cwd, undefined, seeded);
    ({ session } = await createAgentSession({ cwd, agentDir, model: model!, modelRuntime: sessionRuntime, resourceLoader: loader, sessionManager: manager, noTools: "builtin", thinkingLevel: SUBJECT_THINKING_LEVEL }));
    await session.bindExtensions({ onError: () => { extensionFailed = true; } });
    requireProof(!extensionFailed, "error:extension");
    const expectedPrompt = `${SUBJECT_SYSTEM_PROMPT}\n\n<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;
    const isolation = () => requireProof(JSON.stringify(session!.getActiveToolNames()) === JSON.stringify(["context_tree_query"]) && session!.systemPrompt === expectedPrompt, "error:isolation");
    isolation();
    const flushStart = performance.now();
    try { await session.prompt("/pruner now"); } finally { flush = performance.now() - flushStart; }
    requireProof(!extensionFailed, "error:extension");
    const branch = manager.getBranch();
    flushMetrics = branch.filter(e => e.type === "custom" && e.customType === "context-prune-flush-metrics").map(e => (e as any).data);
    summaries = branch.filter(e => e.type === "custom_message" && e.customType === "context-prune-summary").map(e => ({ content: text((e as any).content), details: (e as any).details }));
    const refMap = buildShortRefMap(branch as any);
    shortRefs = [...refMap];
    const indexed = new Set(refMap.values());
    const seededIds = options.scenario.history.flatMap(turn => turn.role === "assistant" ? (turn.toolCalls ?? []).map(c => c.id) : []);
    const flushed = flushMetrics.some((m: any) => m.outcome === "summarized" && m.processedBatches >= 1) && (options.suite === "idle" ? idleFlushIndexed(options.scenario, refMap) : seededIds.every(id => indexed.has(id)));
    const [summaryProvider, summaryId] = options.summarizer.split("/");
    const summaryStatus = classifySummarizer(records, { provider: summaryProvider, id: summaryId }, flushed);
    requireProof(summaryStatus === "ok", summaryStatus);
    observed.setPhase("subject");
    const before = manager.getBranch().length;
    const probeStart = performance.now();
    try { await session.prompt(options.scenario.probe); } finally { probe = performance.now() - probeStart; }
    requireProof(!extensionFailed, "error:extension");
    isolation();
    const first = records.find(r => r.phase === "subject");
    requireProof(first, "error:subject");
    const actualPrompt = first!.context.systemPrompt ?? first!.context.messages.filter(m => m.role === "system").map(m => getSystemMessageText(m as any)).join("\n\n");
    const declaredTools = new Set((first!.context.tools ?? []).map(t => t.name));
    for (const message of first!.context.messages) {
      if (message.role !== "system") continue;
      for (const removed of message.toolsRemoved ?? []) declaredTools.delete(removed.name);
      for (const added of message.toolsAdded ?? []) declaredTools.add(added.name);
    }
    requireProof(actualPrompt === expectedPrompt && JSON.stringify([...declaredTools]) === JSON.stringify(["context_tree_query"]), "error:isolation");
    const outgoing = first!.context.messages;
    const serialized = JSON.stringify(outgoing);
    const rawResults = options.scenario.history.filter(t => t.role === "result");
    if (options.suite === "idle") {
      idleChainEntries = manager.getBranch().filter(e => e.type === "custom" && e.customType === "context-prune-chain");
      assertIdleRequest({ scenario: options.scenario, seeded: seedMessages, branch: idleChainEntries, outgoing, refMap, summaries });
    }
    else requireProof(rawResults.every(t => !serialized.includes(JSON.stringify(t.text).slice(1, -1))) && summaries.some(s => serialized.includes(JSON.stringify(s.content).slice(1, -1))) && seededIds.every(id => [...refMap].some(([ref, indexedId]) => indexedId === id && outgoing.some(m => m.role === "toolResult" && m.toolCallId === id && text(m.content) === `[Summarized in pruner summary, ref \`${ref}\`. Use context_tree_query to retrieve full output.]`))), "error:not-pruned");
    requireProof(classifySummarizer(records, { provider: summaryProvider, id: summaryId }, flushed) === "ok", classifySummarizer(records, { provider: summaryProvider, id: summaryId }, flushed));
    requireProof(records.filter(r => r.phase === "subject").every(r => r.status === "ok" && r.requested.provider === provider && r.requested.id === id && r.answered?.provider === provider && r.answered.id === id), "error:subject");
    const messages = manager.getBranch().slice(before).filter(e => e.type === "message").map(e => (e as any).message);
    messages.forEach((m, index) => {
      if (m.role === "assistant") {
        const calls = m.content.filter((c: any) => c.type === "toolCall");
        if (!calls.length && text(m.content)) { finalAssistantIndex = index; reply = text(m.content); }
        for (const c of calls) {
          const resultIndex = messages.findIndex((r, i) => i > index && r.role === "toolResult" && r.toolCallId === c.id);
          toolCalls.push({ name: c.name, arguments: c.arguments, result: resultIndex < 0 ? "" : text(messages[resultIndex].content), index, resultIndex, toolCallId: c.id });
        }
      }
    });
    requireProof(finalAssistantIndex >= 0, "error:subject");
    observed.setPhase("judge");
    const scored = await score({ scenario: options.scenario, reply, toolCalls, finalAssistantIndex, shortRefMap: refMap, summaries, runtime: observed.runtime });
    ({ status: verdict, check, reason, recovery } = scored);
    if (scored.status === "error") errorReason = "error:judge";
  } catch (error) {
    errorReason = extensionFailed ? "error:extension" : error instanceof JobError ? error.reason : "error:exception";
  } finally {
    session?.dispose();
  }
  const usage = { subject: sumMeasurements(records.filter(r => r.phase === "subject").map(r => r.measurements)), summarizer: sumMeasurements(records.filter(r => r.phase === "summarizer").map(r => r.measurements)) };
  const judgeRecords = records.filter(r => r.phase === "judge");
  const result = {
    scenario: options.scenario.id, summarizer: options.summarizer, runIndex: options.runIndex,
    reply, toolCalls, recovery, usage,
    callCounts: { subject: records.filter(r => r.phase === "subject").length, summarizer: records.filter(r => r.phase === "summarizer").length, judge: judgeRecords.length },
    costProvenance: { subject: usage.subject.cost.provenance, summarizer: usage.summarizer.cost.provenance },
    elapsedMs: { flush, probe, total: performance.now() - started }, attempts: 1,
    status: errorReason ? "error" : "ok", ...(errorReason ? { errorReason } : {}),
    finalAssistantIndex, verdict: verdict ?? "error", check: check ?? errorReason, reason: reason ?? errorReason,
    judgeOverhead: { calls: judgeRecords.length, usage: sumMeasurements(judgeRecords.map(r => r.measurements)), elapsedMs: judgeRecords.reduce((sum, r) => sum + r.elapsedMs, 0) },
    summaries, shortRefs, flushMetrics, records,
    ...(options.suite === "idle" ? { idleChainEntries } : {}),
  };
  await mkdir(jobPath, { recursive: true });
  await writeFile(join(jobPath, "job.json"), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  const [scenarioId, summarizer, runIndex, jobPath, operatorAgentDir, repo, suite = "standard"] = process.argv.slice(2);
  if (!scenarioId || !/^[a-z-]+$/.test(scenarioId) || !summarizer || !Number.isSafeInteger(Number(runIndex)) || !jobPath || !operatorAgentDir || !repo || !["standard", "idle"].includes(suite)) {
    console.error("Usage: bun eval/session.ts <scenario> <summarizer> <run-index> <job-path> <operator-agent-dir> <repo> [standard|idle]");
    process.exitCode = 1;
  } else {
    try {
      const scenario = (await import(`./${suite === "idle" ? "scenarios-idle" : "scenarios"}/${scenarioId}.ts`)).default as Scenario;
      const result = await runJob({ scenario, summarizer, runIndex: Number(runIndex), jobPath, operatorAgentDir, repo, suite: suite as "standard" | "idle" });
      process.exitCode = result.status === "ok" ? 0 : 1;
    } catch {
      await mkdir(jobPath, { recursive: true });
      await writeFile(join(jobPath, "job.json"), JSON.stringify({ status: "error", errorReason: "error:job", attempts: 1 }));
      process.exitCode = 1;
    }
  }
}
