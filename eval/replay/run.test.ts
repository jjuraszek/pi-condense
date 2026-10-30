import { expect, test } from "bun:test";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { observe } from "../observer.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, planReplay, executeReplay, replayMain } from "./run.js";
import { session } from "./oracle.test.js";
import { SUMMARIZER_MODELS, JUDGE_MODEL, PIPELINE_SETTINGS } from "../config.js";
import { CURRENT_SYSTEM_PROMPT } from "./current-prompt.js";
import { SYSTEM_PROMPT, runSummarization } from "../../src/summarizer.js";
import { serializeBatchForSummarizer } from "../../src/batch-capture.js";
import { ToolCallIndexer } from "../../src/indexer.js";
import { substituteInlineRefs, formatSummaryToolCallRefs } from "../../src/summary-refs.js";
import { assertOutsideRepo } from "./paths.js";

const model = SUMMARIZER_MODELS[0];
const text = "7319 " + "x".repeat(PIPELINE_SETTINGS.minBatchChars + 100);
function corpus() { return [{ stem: "one", session: session(text) }]; }
function answer(text: string, stopReason = "stop") { return { role: "assistant", provider: "test", model: "test", api: "test", timestamp: 0, content: [{ type: "text", text }], stopReason, usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0, total: .03 } } }; }
function runtime(responses: any[] = [answer("7319"), answer("7319")], judgeAnswers = [answer('{"verdict":"same","reason":"Both preserve evidence."}')]) {
  const requests: any[] = [], judges: any[] = [];
  return { requests, judges, getAuth: async () => ({ auth: { apiKey: "synthetic" }, env: {} }), hasConfiguredAuth: () => true, getModel(provider: string, id: string) { return { provider, id, api: "test" }; }, streamSimple(m: any, ctx: any, options: any) {
    requests.push({ m, ctx, options });
    const value = responses.shift() ?? answer("7319");
    if (value instanceof Error) throw value;
    return { async *[Symbol.asyncIterator]() {}, result: async () => value };
  }, async completeSimple(m: any, ctx: any) { judges.push({ m, ctx }); const value = judgeAnswers.shift() ?? answer('{"verdict":"same","reason":"Same evidence."}'); if (value instanceof Error) throw value; return value; } };
}

test("parse limits, arbitrary model shapes, thinking and output", () => {
  expect(parseArgs(["run", "--corpus", "/tmp/private", "--limit", "2", "--models", model, "--dry-run"])).toMatchObject({ limit: 2, models: [model], dryRun: true });
  for (const value of ["0", "-1", "1.5", "NaN"]) expect(() => parseArgs(["run", "--corpus", "/tmp", "--limit", value])).toThrow();
  expect(parseArgs(["run", "--corpus", "/tmp", "--models", "unknown/model", "--thinking", "high", "--out", "/tmp/out"])).toMatchObject({ models: ["unknown/model"], thinking: "high", out: "/tmp/out" });
  expect(parseArgs(["run", "--corpus", "/tmp"])).toMatchObject({ thinking: PIPELINE_SETTINGS.summarizerThinking, out: "/tmp" });
  for (const value of ["bad", "a/b/c", "a/ b", "a/b,a/b"]) expect(() => parseArgs(["run", "--corpus", "/tmp", "--models", value])).toThrow();
  expect(() => parseArgs(["run", "--corpus", "/tmp", "--thinking", "invalid"])).toThrow();
});

test("stable file/turn ordering, specific skips and exact planned calls", () => {
  const a = session(text); a.batches[0].turnIndex = 5;
  a.batches.push({ ...a.batches[0], turnIndex: 2 }); a.batchPositions.push(a.batchPositions[0]);
  const trivial = session("small");
  const spilled = session(""); spilled.batches[0].toolCalls[0].spillPath = "/outside/no-body"; spilled.batchPositions[0].results[0].spilled = true;
  const input = [{ stem: "z", session: a }, { stem: "a", session: session(text) }, { stem: "trivial", session: trivial }, { stem: "spill", session: spilled }];
  const first = planReplay(input, [model], "off", 2);
  expect(first).toEqual(planReplay(input, [model], "off", 2));
  expect(first.selected.map(r => [r.stem, r.batch.turnIndex])).toEqual([["a", 0], ["z", 2]]);
  expect(first).toMatchObject({ eligible: 3, skippedTrivial: 1, skippedSpilled: 1, summarizerCalls: 4, judgeCalls: 2 });
});

test("dry run guards corpus and makes no runtime or model calls, ignores jobs metadata", async () => {
  const dir = assertOutsideRepo(mkdtempSync(join(tmpdir(), "replay-run-")));
  writeFileSync(join(dir, "one.json"), JSON.stringify(session(text)));
  writeFileSync(join(dir, "jobs.json"), "{}"); writeFileSync(join(dir, "counts.json"), "{}");
  let calls = 0; const logs: string[] = [];
  expect(await replayMain(["run", "--corpus", dir, "--dry-run"], { runtime: async () => { calls++; throw Error("No runtime in dry-run"); }, print: t => logs.push(t) })).toBe(0);
  expect(calls).toBe(0); expect(logs.join(" ")).toContain('"summarizerCalls":4'); expect(logs.join(" ")).toContain('"judgeCalls":2');
});

test("production arms use frozen/current serializer, pinned context and decorated retention", async () => {
  const s = session("x".repeat(4000) + "\nretry_window_ms: 7319\n" + "x".repeat(4000));
  const rt = runtime();
  const result = await executeReplay(planReplay([{ stem: "one", session: s }], [model]), rt, async () => {});
  expect(result.exitCode).toBe(0);
  for (const [i, prompt] of [CURRENT_SYSTEM_PROMPT, SYSTEM_PROMPT].entries()) {
    const serialization = serializeBatchForSummarizer(s.batches[0], i === 0 ? { middleChars: 0 } : undefined);
    expect(rt.requests[i].ctx.messages[0].content[0].text).toBe(prompt + "\n\n<tool-call-batch>\n" + serialization + "\n</tool-call-batch>");
    expect(`${rt.requests[i].m.provider}/${rt.requests[i].m.id}`).toBe(model);
  }
  const refs = new ToolCallIndexer().allocateSummaryRefs(s.batches[0]);
  const decorated = substituteInlineRefs("7319", refs, ["bash"]) + formatSummaryToolCallRefs(refs);
  expect(result.rows[0].current.text).toBe(decorated);
  expect(result.rows[0].candidate.text).toBe(decorated);
  expect(rt.judges[0].m.id).toBe(JUDGE_MODEL.split("/")[1]);
  expect(result.rows[0].assignment).toBe("candidate=A");
  for (const arm of [result.rows[0].current, result.rows[0].candidate]) {
    expect(arm.outcome).toBe("retained");
    expect(arm.attempts[0].records).toHaveLength(1);
    expect(arm.attempts[0].records[0]).toMatchObject({ phase: "summarizer", requested: { provider: model.split("/")[0], id: model.split("/")[1] }, response: { text: "7319", stopReason: "stop" }, usage: { input: 11, output: 7 } });
  }
  expect(rt.requests).toHaveLength(2);
  expect("find" in rt).toBe(false);
  expect("getApiKeyAndHeaders" in rt).toBe(false);
  const observed = observe(rt);
  observed.setPhase("summarizer");
  expect(await runSummarization("message", { ...PIPELINE_SETTINGS, summarizerModel: model }, { model: rt.getModel(...model.split("/") as [string, string]), modelRegistry: new ModelRegistry(observed.runtime as any), ui: { notify() {} } } as any, { signal: new AbortController().signal })).not.toBeNull();
  expect(observed.records[0].response?.text).toBe("7319");
});

test.each([["oversized", "rejected-oversized"], ["empty", "unusable:empty"], ["length", "unusable:length"], ["error", "error"]])("%s receives no retention or characters but preserves attempts", async (kind, outcome) => {
  const value = kind === "oversized" ? answer("z".repeat(text.length - 1)) : kind === "error" ? new Error("broken") : answer(kind === "length" ? "7319" : "", kind === "length" ? "length" : "stop");
  const result = await executeReplay(planReplay(corpus(), [model]), runtime([value, answer("7319")]), async () => {});
  expect(result.rows[0].current.outcome).toBe(outcome);
  expect(result.rows[0].current.text).toBeUndefined();
  expect(result.rows[0].current.attempts).toHaveLength(1);
  if (kind !== "error") expect(result.rows[0].current.attempts[0].records[0].usage.input).toBe(11);
  expect(result.rows[0].judge.verdict).toBe("skipped");
});

test("every string is scored including both-arm misses with scanner/model attribution", async () => {
  const s = session("x".repeat(4000) + "\nplain missing_key\nselected_key: 9911\n" + "x".repeat(4000));
  const result = await executeReplay(planReplay([{ stem: "one", session: s }], [model]), runtime([answer("plain 9911"), answer("nothing")]), async () => {});
  const scores = result.rows[0].scores;
  expect(scores.find(s => s.text === "missing_key")).toMatchObject({ retainedCurrent: false, retainedCandidate: false, attribution: "scanner-missed", inMiddle: true });
  expect(scores.find(s => s.text === "9911")).toMatchObject({ retainedCurrent: true, retainedCandidate: false, attribution: "model-dropped" });
  expect(result.exitCode).toBe(2);
});

test("gate writes regression report; advisory preference alone passes; blind assignment alternates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-gate-")); writeFileSync(join(dir, "one.json"), JSON.stringify(session(text)));
  const out = join(dir, "results");
  const fail = runtime([answer("7319"), answer("nothing")]);
  expect(await replayMain(["run", "--corpus", dir, "--models", model, "--thinking", "high", "--out", out], { runtime: async () => fail, print() {} })).toBe(2);
  expect(readFileSync(join(out, "report.md"), "utf8")).toContain("Gate: FAIL (1 regressions)");
  expect(JSON.parse(readFileSync(join(out, "jobs.json"), "utf8")).thinking).toBe("high");
  expect(fail.requests.map(r => r.options.reasoning)).toEqual(["high", "high"]);
  expect(fail.requests[0].options.reasoning).toBe("high");
  const logs: string[] = [];
  expect(await replayMain(["matrix", join(out, "jobs.json")], { print: text => logs.push(text) })).toBe(0);
  expect(logs.join("")).toContain("high");
  await expect(replayMain(["run", "--corpus", dir, "--out", process.cwd(), "--dry-run"])).rejects.toThrow();
  const rt = runtime(undefined, [answer('{"verdict":"B better","reason":"Clearer uncertainty."}'), answer('{"verdict":"A better","reason":"Clearer uncertainty."}')]);
  const result = await executeReplay(planReplay([...corpus(), { stem: "two", session: session(text) }], [model]), rt, async () => {});
  expect(result.exitCode).toBe(0);
  expect(result.rows.map(r => r.assignment)).toEqual(["candidate=A", "candidate=B"]);
  expect(result.rows.map(r => r.judge.verdict)).toEqual(["current better", "current better"]);
  expect(rt.judges[0].ctx.messages[0].content).not.toContain('"current"');
});

test("only 429/transport retry per call, malformed judge retry is independent", async () => {
  const transport = Object.assign(new Error("network"), { code: "ECONNRESET" });
  const http = Object.assign(new Error("busy"), { status: 429 });
  const rt = runtime([transport, http, answer("7319"), answer("7319")], [transport, answer("invalid"), http, answer('{"verdict":"same","reason":"Evidence equal."}')]);
  const sleeps: number[] = [];
  const result = await executeReplay(planReplay(corpus(), [model]), rt, async ms => { sleeps.push(ms); });
  expect(result.exitCode).toBe(0); expect(sleeps).toEqual([2000, 8000, 2000, 2000]);
  expect(rt.requests).toHaveLength(4); expect(rt.judges).toHaveLength(4);
  expect(result.rows[0].current.attempts).toHaveLength(3);
});

test("provider exhaustion and malformed judge error produce incomplete results", async () => {
  const error = () => Object.assign(new Error("busy"), { status: 429 });
  const result = await executeReplay(planReplay(corpus(), [model]), runtime([error(), error(), error(), answer("7319")]), async () => {});
  expect(result.exitCode).toBe(1); expect(result.incomplete).toBe(true);
  const malformed = await executeReplay(planReplay(corpus(), [model]), runtime(undefined, [answer("invalid"), answer("invalid")]), async () => {});
  expect(malformed.exitCode).toBe(1); expect(malformed.rows[0].judge.verdict).toBe("error");
});

test("production timeout notifications classify abandoned arms without retention", async () => {
  const rt = runtime();
  rt.streamSimple = (m: any, ctx: any, options: any) => {
    rt.requests.push({ m, ctx, options });
    const pending = new Promise<any>(resolve => options.signal.addEventListener("abort", () => resolve(answer("", "aborted")), { once: true }));
    return { async *[Symbol.asyncIterator]() {}, result: () => pending };
  };
  const idle = PIPELINE_SETTINGS.summarizerIdleTimeoutMs;
  PIPELINE_SETTINGS.summarizerIdleTimeoutMs = 1;
  try {
    const result = await executeReplay(planReplay(corpus(), [model]), rt, async () => {});
    expect(result.exitCode).toBe(0);
    for (const arm of [result.rows[0].current, result.rows[0].candidate]) {
      expect(arm.outcome).toBe("unusable:timeout");
      expect(arm.text).toBeUndefined();
      expect(arm.attempts[0].notifications[0]).toContain("summarizer call abandoned");
      expect(arm.attempts[0].records[0].usage?.input).toBe(11);
    }
    expect(result.rows[0].judge.verdict).toBe("skipped");
  } finally { PIPELINE_SETTINGS.summarizerIdleTimeoutMs = idle; }
});

test("preflight stops missing auth before any paid call", async () => {
  const rt = runtime(); rt.hasConfiguredAuth = () => false;
  await expect(executeReplay(planReplay(corpus(), [model]), rt, async () => {})).rejects.toThrow("unauthenticated");
  expect(rt.requests).toHaveLength(0); expect(rt.judges).toHaveLength(0);
});

test.each(["delayed", "never"])("abandoned %s provider stays owned by its attempt", async settlement => {
  const rt = runtime();
  let finishCurrent: (value: any) => void = () => {};
  rt.streamSimple = (m: any, ctx: any, options: any) => {
    rt.requests.push({ m, ctx, options });
    if (rt.requests.length === 1) {
      const pending = new Promise<any>(resolve => { finishCurrent = resolve; });
      return { async *[Symbol.asyncIterator]() {}, result: () => pending };
    }
    const pending = (async () => {
      if (settlement === "delayed") finishCurrent(answer("late current", "aborted"));
      await new Promise(resolve => setTimeout(resolve, 0));
      return answer("7319");
    })();
    return { async *[Symbol.asyncIterator]() {}, result: () => pending };
  };
  const idle = PIPELINE_SETTINGS.summarizerIdleTimeoutMs;
  PIPELINE_SETTINGS.summarizerIdleTimeoutMs = 10;
  try {
    const result = await executeReplay(planReplay(corpus(), [model]), rt, async () => {});
    const { current, candidate } = result.rows[0];
    expect(current.outcome).toBe("unusable:timeout");
    expect(current.attempts[0].records).toEqual([]);
    expect(candidate.outcome).toBe("retained");
    expect(candidate.attempts[0].records.map(r => r.response?.text)).toEqual(["7319"]);
  } finally { PIPELINE_SETTINGS.summarizerIdleTimeoutMs = idle; }
});
