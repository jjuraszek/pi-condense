import { describe, test, expect, mock, spyOn } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { parseArgs, pool, retryJob, preflight, main, baselineName, installedVersions, type MainSeams } from "./run";
import { renderReport, compareReports, readReport, assertCompatible, measurement, header, jobTotal, baselineEstimate } from "./report";
import { SUBJECT_MODEL, JUDGE_MODEL, SUMMARIZER_MODELS } from "./config";
import { sumMeasurements } from "./observer";
import * as observer from "./observer";

const scenario = { id: "case", title: "Case", tests: "Tests behavior.", history: [], probe: "?", mechanical: { contains: ["answer"] } };
const job = (verdict = "pass") => ({ scenario: "case", runIndex: 0, status: verdict === "error" ? "error" : "ok", verdict, reason: "reason", check: "mechanical", reply: "x".repeat(700), toolCalls: [], recovery: [], elapsedMs: { total: 10 }, attempts: 1, records: [] });
const report = (jobs = [job()]) => ({ key: { runs: 3 }, versions: { sdk: "1" }, revision: "sha", date: "date", settings: {}, scenarios: [scenario], jobs });

describe("paid CLI safety", () => {
  test.each([[], ["--compare"], ["--change", " "], ["--what"], ["--baseline", "--compare"], ["--baseline", "--change", "x"], ["--baseline", "--runs", "2"], ["--runs", "0", "--change", "x"], ["--summarizer", "bad", "--change", "x"]].map(args => ({ args })))("rejects %j", ({ args }) => expect(() => parseArgs(args)).toThrow());
  test("bare invocation explains both commands and default compare", () => {
    try { parseArgs([]); } catch (e) { expect(String(e)).toContain('npm run eval -- --change'); expect(String(e)).toContain('npm run eval -- --baseline'); }
    expect(parseArgs(["--change", "fix"]).mode).toBe("compare");
    expect(parseArgs(["--baseline"]).summarizers).toEqual([...SUMMARIZER_MODELS]);
    expect(() => parseArgs(["--baseline"], { EVAL_CONCURRENCY: "0" })).toThrow();
  });
  test("dirty tracked and untracked trees never initialize runtime", async () => {
    for (const status of [" M file", "?? file"]) {
      let calls = 0;
      await expect(preflight({ git: async () => status, operatorDir: () => "operator", runtime: async () => { calls++; throw Error(); } }, [...SUMMARIZER_MODELS])).rejects.toThrow(status);
      expect(calls).toBe(0);
    }
  });
  test.each([false, true])("missing model or auth aborts with guidance %j", async auth => {
    await expect(preflight({ git: async () => "", operatorDir: () => "operator", runtime: async () => ({ getModel: () => auth ? {} : undefined, hasConfiguredAuth: () => false }) }, [...SUMMARIZER_MODELS])).rejects.toThrow("pi --list-models");
  });
  test("default preflight observes its read-only runtime and preserves model/auth lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "condense-preflight-"));
    const credential = { type: "api_key", key: "synthetic-offline" };
    const auth = JSON.stringify({ anthropic: credential });
    await writeFile(join(dir, "auth.json"), auth);
    const names = [...new Set([SUBJECT_MODEL, JUDGE_MODEL, ...SUMMARIZER_MODELS])];
    const lookups: string[] = [], authChecks: string[] = [];
    const invoke = mock(() => { throw Error("preflight invoked a model"); });
    const runtime = {
      getModel(provider: string, id: string) { expect(this).toBe(runtime); lookups.push(`${provider}/${id}`); return { provider, id }; },
      hasConfiguredAuth(provider: string) { expect(this).toBe(runtime); authChecks.push(provider); return provider === "anthropic"; },
      streamSimple: invoke, completeSimple: invoke,
    };
    const create = spyOn(ModelRuntime, "create").mockImplementation(async options => {
      expect(options?.credentials).toBeInstanceOf(InMemoryCredentialStore);
      expect(await options!.credentials!.read("anthropic")).toEqual(credential);
      expect(await options!.credentials!.read("github-copilot")).toBeUndefined();
      expect(options?.modelsStore).toBeInstanceOf(InMemoryModelsStore);
      expect(options?.modelsPath).toBe(join(dir, "models.json"));
      expect(options?.allowModelNetwork).toBe(false);
      expect(options?.authPath).toBeUndefined();
      expect(options?.modelsStorePath).toBeUndefined();
      return runtime as unknown as ModelRuntime;
    });
    const accesses: PropertyKey[] = [], observe = observer.observe;
    const observed = spyOn(observer, "observe").mockImplementation(original => {
      const result = observe(original);
      return { ...result, runtime: new Proxy(result.runtime, {
        get(target, key) { if (key === "getModel" || key === "hasConfiguredAuth") accesses.push(key); return Reflect.get(target, key); },
      }) };
    });
    const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      expect(args[0]).toBe("git");
      expect(["status", "rev-parse"]).toContain(args[3]);
      return { stdout: new Response(args[3] === "status" ? "" : "full-sha").body, stderr: new Response("").body, exited: Promise.resolve(0) };
    }) as any);
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => { throw Error("preflight accessed the network"); });
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await expect(main(["--change", "offline preflight"])).rejects.toThrow(`Missing or unauthenticated model ${SUMMARIZER_MODELS[1]}; check pi --list-models`);
      expect(create).toHaveBeenCalledTimes(1);
      expect(lookups).toEqual(names);
      expect(authChecks).toEqual(names.map(name => name.split("/")[0]));
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(runtime);
      expect(accesses).toEqual(names.flatMap(() => ["getModel", "hasConfiguredAuth"]));
      expect(observed.mock.results[0].value.runtime).not.toBe(runtime);
      expect(observed.mock.results[0].value.records).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(await readdir(dir)).toEqual(["auth.json"]);
      expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(auth);
    } finally {
      create.mockRestore(); observed.mockRestore(); spawn.mockRestore(); fetch.mockRestore();
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });
});

describe("reports", () => {
  test("default version discovery reads both installed ESM-only SDK packages", async () => {
    const expected: Record<string, string> = {};
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
      const metadata = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.resolve(name))), "../package.json"), "utf8"));
      expect(metadata.name).toBe(name);
      expect(metadata.version).toBeString();
      expect(metadata.version.length).toBeGreaterThan(0);
      expected[name] = metadata.version;
    }
    expect(installedVersions()).toEqual(expected);
  });
  test.each([null, false, {}, { key: {} }])("rejects malformed decoded baseline shape %j", value => {
    const md = `<!-- pi-condense-eval:v1:${Buffer.from(JSON.stringify(value)).toString("base64")} -->`;
    expect(() => readReport(md)).toThrow("Invalid baseline");
  });
  test.each([0, 1])("judge call count %s distinguishes absent phase from missing measurements", calls => {
    const measured = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].map(f => [f, { value: 2, provenance: "measured" }]));
    const j = { ...job(), usage: { subject: measured, summarizer: measured }, callCounts: { subject: 1, summarizer: 1, judge: calls }, judgeOverhead: { calls, usage: sumMeasurements([]), elapsedMs: 0 } };
    expect(jobTotal(j).cost).toEqual(calls ? { provenance: "unavailable" } : { value: 4, provenance: "measured" });
    expect(baselineEstimate(report([j]) as any)).toBe(calls ? "unavailable / 10 ms" : "4 / 10 ms");
    expect(readReport(renderReport(report([j]) as any)).jobs[0].callCounts).toEqual(j.callCounts);
  });
  test("retains safe observations, missingness, estimates and metadata", () => {
    const r = report([job("fail"), job("error")]);
    const md = renderReport(r as any);
    expect(md).toContain("passes 0/3, errors 1");
    expect(md).toContain("unavailable (no baseline yet)");
    expect(md).toContain("reason");
    expect(md).toContain("x".repeat(600));
    expect(md).not.toContain("x".repeat(601));
    expect(readReport(md).jobs[0].reply.length).toBe(600);
    expect(measurement(undefined)).toBe("unavailable");
    expect(measurement({ value: 0, provenance: "measured" })).toBe("0");
    expect(measurement({ value: 2, provenance: "estimated" })).toBe("2 (estimated)");
  });
  test("ordered tool outcomes and safe metadata exclude raw logs and full replies", () => {
    const j = { ...job(), records: [{ context: "secret raw context", judgeResponse: { text: "RAW_JUDGE_DIAGNOSTIC_MARKER", stopReason: "stop" } }], summaries: [{ content: "retained", details: {} }], toolCalls: [
      { name: "context_tree_query", arguments: { toolCallIds: ["t2"] }, index: 2, result: "## toolRef: t2\n(not found in index)" },
      { name: "context_tree_query", arguments: { toolCallIds: ["t1"] }, index: 1, result: "## toolRef: t1\nTool: read\nanswer" },
    ] };
    const md = renderReport(report([j]) as any);
    expect(md).toContain("-> returned-source"); expect(md).toContain("-> not-found");
    const safe = readReport(md).jobs[0];
    expect(safe.records).toBeUndefined(); expect(safe.summaries).toEqual(j.summaries);
    expect(md).not.toContain("RAW_JUDGE_DIAGNOSTIC_MARKER");
    expect(JSON.stringify(safe)).not.toContain("RAW_JUDGE_DIAGNOSTIC_MARKER");
    expect(safe.toolCalls[0].index).toBe(1); expect(safe.toolCalls[0].result).toBeUndefined();
  });
  test("all identity differences abort, versions only warn", () => {
    for (const key of ["subject", "prompt", "thinking", "summarizer", "judge", "judgePromptHash", "settingsHash", "corpusHash", "runs"]) {
      expect(() => assertCompatible({ ...report(), key: { [key]: "a" } } as any, { ...report(), key: { [key]: "b" } } as any)).toThrow("Comparison key mismatch");
    }
    expect(assertCompatible(report() as any, { ...report(), versions: { sdk: "2" } } as any)).toContain("WARNING");
  });
  test("key mismatch includes both complete report headers", () => {
    const baseline = { ...report(), revision: "baseline-sha", date: "baseline-date", settings: { limit: 1 }, estimate: "baseline estimate" };
    const candidate = { ...report(), key: { runs: 2 }, versions: { sdk: "2" }, revision: "candidate-sha", date: "candidate-date", settings: { limit: 2 }, change: "candidate change" };
    expect(() => assertCompatible(baseline, candidate)).toThrow(`Comparison key mismatch\nBaseline:\n${header(baseline)}\nCandidate:\n${header(candidate)}`);
  });
  test("comparison separates errors, changes and regressions with missing deltas", () => {
    const result = compareReports(report() as any, report([job("fail"), job("error")]) as any, "change");
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("REGRESSION CANDIDATE: case 1/3 -> 0/3");
    expect(result.text).toContain("Errors: 1");
    expect(result.text).toContain("unavailable");
    expect(result.text).toContain("change");
  });
});

describe("bounded attempts", () => {
  test("pool bounds concurrent jobs and preserves ordering", async () => {
    let live = 0, peak = 0;
    const values = await pool(Array.from({ length: 21 }, (_, i) => i), 3, async i => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 1)); live--; return i; });
    expect(peak).toBe(3); expect(values).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });
  test("structured terminal provider retry uses fresh dirs and exact delays", async () => {
    const delays: number[] = [], dirs: string[] = [];
    const result = await retryJob("root/job", async dir => { dirs.push(dir); return { ...job("error"), errorReason: "error:subject", records: [{ phase: "subject", status: "error:http", retry: { retryable: true, kind: "http", httpStatus: 429 }, measurements: sumMeasurements([]) }] }; }, async ms => { delays.push(ms); });
    expect(delays).toEqual([2000, 8000]); expect(new Set(dirs).size).toBe(3); expect(result.errorReason).toBe("error:provider"); expect(result.attempts).toBe(3);
  });
  test("retry success retains wasted usage and judge overhead; missing time stays unavailable", async () => {
    let n = 0;
    const result = await retryJob("root/job", async () => ++n === 1 ? { ...job("error"), errorReason: "error:subject", records: [{ phase: "subject", status: "error:transport", retry: { retryable: true, kind: "transport" }, measurements: sumMeasurements([]) }] } : { ...job(), judgeOverhead: { elapsedMs: 7, usage: sumMeasurements([]) } }, async () => {});
    expect(result.attempts).toBe(2); expect(result.elapsedMs.total).toBe(2020);
    expect(result.retryOverhead.elapsedMs).toBe(2010); expect(result.judgeOverhead.elapsedMs).toBe(7);
    expect(result.retryOverhead.usage.cost.provenance).toBe("unavailable");
    const missing = await retryJob("root/job", async () => ({ status: "error", errorReason: "error:job" }), async () => {});
    expect(missing.elapsedMs.total).toBeUndefined();
  });
  test.each([
    ["summarizer", "subject", true], ["summarizer-fallback", "subject", true],
    ["judge", "judge", false], ["isolation", "subject", true], ["no-flush", "subject", true],
    ["not-pruned", "subject", true], ["extension", "subject", true], ["subject", "summarizer", true],
  ])("does not retry %s with terminal phase %s", async (reason, phase, retryable) => {
    let calls = 0;
    await retryJob("root/job", async () => { calls++; return { ...job("error"), errorReason: `error:${reason}`, records: [{ phase, status: "error:transport", retry: { retryable, kind: "transport" } }] }; }, async () => { throw Error("slept"); });
    expect(calls).toBe(1);
  });
});

function harness(verdict = "fail") {
  const writes = new Map<string, string>(), messages: string[] = [], spawns: { args: string[]; env: any; cwd: string }[] = [];
  let temps = 0;
  const env = { PI_CODING_AGENT_DIR: "operator", EVAL_CONCURRENCY: "2" };
  const seams: MainSeams = {
    repo: "/repo", env, now: () => new Date(0), versions: () => ({ sdk: "1" }),
    git: async args => args[0] === "status" ? "" : "full-sha", operatorDir: () => env.PI_CODING_AGENT_DIR,
    runtime: async () => ({ getModel: () => ({}), hasConfiguredAuth: () => true }),
    files: async () => Array.from({ length: 7 }, (_, i) => `case-${i}.ts`),
    load: async path => ({ ...scenario, id: path.split("/").at(-1)!.replace(".ts", "") }),
    read: async path => {
      if (writes.has(path)) return writes.get(path)!;
      if (path.includes("scenarios")) return "synthetic bytes";
      throw Error("missing");
    },
    temp: async () => { temps++; return "/temp"; }, mkdir: async () => {},
    write: async (path, text) => { writes.set(path, text); },
    spawn: async (args, childEnv, cwd) => {
      spawns.push({ args, env: childEnv, cwd });
      writes.set(`${cwd}/job.json`, JSON.stringify({ ...job(verdict), scenario: args[2], summarizer: args[3], runIndex: Number(args[4]) }));
    },
    sleep: async () => {}, print: text => { messages.push(text); },
  };
  return { seams, writes, messages, spawns, temps: () => temps };
}

describe("offline orchestration boundary", () => {
  test("7x3 per model writes failing baselines only after all jobs and isolates environments", async () => {
    const h = harness();
    h.seams.write = async (path, text) => { expect(h.spawns.length).toBe(42); h.writes.set(path, text); };
    expect(await main(["--baseline"], h.seams)).toBe(0);
    expect(h.spawns.length).toBe(42);
    expect(h.seams.env.PI_CODING_AGENT_DIR).toBe("operator");
    expect(new Set(h.spawns.map(s => s.env.PI_CODING_AGENT_DIR)).size).toBe(42);
    for (const spawn of h.spawns) {
      expect(spawn.args[1]).toBe("/repo/eval/session.ts");
      expect(spawn.args[6]).toBe("operator");
      expect(spawn.env.PI_CODING_AGENT_DIR).toBe(`${spawn.cwd}/agent`);
      expect(spawn.cwd.startsWith("/temp/")).toBe(true);
    }
    expect(h.writes.has(`/repo/eval/baseline/${baselineName(SUMMARIZER_MODELS[0])}`)).toBe(true);
    const md = h.writes.get(`/repo/eval/baseline/${baselineName(SUMMARIZER_MODELS[0])}`)!;
    expect(readReport(md).jobs.length).toBe(21);
    expect(md).not.toContain('"history"');
    expect(h.messages.at(-1)).toBe("Retained evidence: /temp");
    expect(h.messages.filter(m => m === "Retained evidence: /temp")).toHaveLength(1);
  });
  test("successful retries appear in the report header and final Report line", async () => {
    const h = harness("pass"), delays: number[] = [];
    h.seams.files = async () => ["case.ts"];
    h.seams.sleep = async ms => { delays.push(ms); };
    const spawn = h.seams.spawn;
    h.seams.spawn = async (args, env, cwd, logPath) => {
      await spawn(args, env, cwd, logPath);
      if (args[4] === "0" && cwd.endsWith("attempt-1")) h.writes.set(`${cwd}/job.json`, JSON.stringify({
        ...job("error"), errorReason: "error:subject",
        records: [{ phase: "subject", status: "error:transport", retry: { retryable: true, kind: "transport" }, measurements: sumMeasurements([]) }],
      }));
    };
    expect(await main(["--baseline", "--summarizer", SUMMARIZER_MODELS[0]], h.seams)).toBe(0);
    const path = `/repo/eval/baseline/${baselineName(SUMMARIZER_MODELS[0])}`;
    const md = h.writes.get(path)!;
    expect(md.split("\n").find(line => line.startsWith("Retry policy:"))).toEndWith("; retries: 1.");
    expect(h.messages.filter(line => line.startsWith("Report:"))).toEqual([`Report: ${path}; retries: 1`]);
    expect(readReport(md).jobs.map(j => j.attempts)).toEqual([2, 1, 1]);
    expect(delays).toEqual([2000]);
    expect(h.spawns).toHaveLength(4);
  });
  test("errors forbid every baseline write, single selection touches one report", async () => {
    const broken = harness("error");
    expect(await main(["--baseline"], broken.seams)).toBe(1);
    expect([...broken.writes.keys()].filter(p => p.includes("baseline"))).toEqual([]);
    expect(broken.messages.at(-1)).toBe("Retained evidence: /temp");
    const h = harness();
    expect(await main(["--baseline", "--summarizer", SUMMARIZER_MODELS[1]], h.seams)).toBe(0);
    expect(h.spawns.length).toBe(21);
    expect([...h.writes.keys()].filter(p => p.includes("baseline")).length).toBe(1);
  });
  test.each(["mkdir", "write"] as const)("retains root as final output when %s throws after root creation", async operation => {
    const h = harness();
    h.seams[operation] = async () => { h.seams.print(`${operation} started`); throw Error(`${operation} failed`); };
    await expect(main(["--baseline"], h.seams)).rejects.toThrow(`${operation} failed`);
    expect(h.temps()).toBe(1);
    expect(h.messages.at(-1)).toBe("Retained evidence: /temp");
    expect(h.messages.filter(m => m === "Retained evidence: /temp")).toHaveLength(1);
  });
  test("missing baseline and changed identity refuse before temp or spawn", async () => {
    const missing = harness();
    await expect(main(["--change", "candidate"], missing.seams)).rejects.toThrow("--baseline");
    expect(missing.temps()).toBe(0); expect(missing.spawns.length).toBe(0);
    const h = harness();
    await main(["--baseline"], h.seams);
    const before = h.spawns.length;
    await expect(main(["--change", "candidate", "--runs", "2"], h.seams)).rejects.toThrow("Comparison key mismatch");
    expect(h.spawns.length).toBe(before);
  });
  test.each(["baseline", "compare"])("stale corpus %s recaptures or reports full header mismatch before jobs", async mode => {
    const h = harness();
    await main(["--baseline"], h.seams);
    const path = `/repo/eval/baseline/${baselineName(SUMMARIZER_MODELS[0])}`;
    const previous = readReport(h.writes.get(path)!);
    h.seams.files = async () => ["new-case.ts"];
    h.messages.length = 0;
    const temps = h.temps(), spawns = h.spawns.length;
    if (mode === "baseline") {
      expect(await main(["--baseline"], h.seams)).toBe(0);
      expect(readReport(h.writes.get(path)!).scenarios.map(s => s.id)).toEqual(["new-case"]);
      expect(h.messages[0].split("\n")).toContain("Estimated cost / duration: unavailable (no baseline yet)");
      expect(h.messages[0]).not.toContain("/ 210 ms");
    } else {
      try {
        await main(["--change", "candidate"], h.seams);
        throw Error("did not reject");
      } catch (error) {
        expect(String(error)).toContain(`Comparison key mismatch\nBaseline:\n${header(previous)}\nCandidate:\n# Behavioral context-retention eval`);
        expect(String(error)).toContain("Intended change: candidate");
      }
      expect(h.temps()).toBe(temps); expect(h.spawns.length).toBe(spawns);
    }
  });
  test.each(["empty", "duplicate", "verdict", "status", "errors", "scenario"])("malformed same-key baseline %s aborts before temp or spawn", async defect => {
    const h = harness();
    await main(["--baseline"], h.seams);
    for (const [path, md] of h.writes) {
      if (!path.includes("baseline")) continue;
      const r = readReport(md);
      if (defect === "empty") r.jobs = [];
      if (defect === "duplicate") r.jobs[1] = r.jobs[0];
      if (defect === "verdict") r.jobs[0].verdict = "unknown";
      if (defect === "status") r.jobs[0].status = "unknown";
      if (defect === "errors") { r.jobs[0].status = "error"; r.jobs[0].verdict = "error"; }
      if (defect === "scenario") r.scenarios.pop();
      h.writes.set(path, renderReport(r));
    }
    const temps = h.temps(), spawns = h.spawns.length;
    await expect(main(["--change", "candidate"], h.seams)).rejects.toThrow("Invalid baseline");
    expect(h.temps()).toBe(temps); expect(h.spawns.length).toBe(spawns);
  });
  test("compare writes candidate only in temp and prints every case", async () => {
    const h = harness();
    await main(["--baseline"], h.seams);
    expect(await main(["--compare", "--change", "candidate"], h.seams)).toBe(0);
    expect(h.writes.has(`/temp/${baselineName(SUMMARIZER_MODELS[0])}`)).toBe(true);
    for (let i = 0; i < 7; i++) expect(h.messages.join("\n")).toContain(`case-${i}: baseline 0/3 -> candidate 0/3 =`);
    expect(h.messages.at(-1)).toBe("Retained evidence: /temp");
  });
});

test.each([
  ["retained and skipped", [{ content: "value=42", details: { toolCallRefs: [{ shortId: "t1", toolCallId: "call_a" }] } }], ["summarized", "skipped-trivial", "skipped-oversized", "empty", "error", "skipped-deduped"], "8", "retained 1, skipped-trivial 1, skipped-oversized 1, unusable 2", true],
  ["absent", undefined, undefined, "unavailable", "unavailable", false],
  ["only dedup", [], ["skipped-deduped"], "unavailable", "retained 0, skipped-trivial 0, skipped-oversized 0, unusable 0", false],
] as const)("report retention measurements: %s", (_name, summaries, outcomes, chars, counts, retained) => {
  const j = { ...job(), summaries, flushMetrics: outcomes?.map(outcome => ({ outcome })), recovery: [{ id: "call_a", outcome: "hit", summaryRetained: retained }], usage: { summarizer: sumMeasurements([]) } };
  const r = report([j]);
  const md = renderReport(r as any);
  expect(md).toContain(`Summary chars: ${chars}`);
  expect(md).toContain(`Summaries: ${counts}`);
  expect(md).toContain(`evidence in summary: ${retained ? 1 : 0}/1`);
  expect(md).toContain("| summarizer | unavailable | unavailable |");
  const saved = readReport(md);
  expect(saved.jobs[0].summaries).toEqual(summaries);
  expect(saved.jobs[0].flushMetrics).toEqual(j.flushMetrics);
  expect(saved.jobs[0].usage).toEqual(j.usage);
  expect(saved.key).toEqual(r.key);
  expect(saved.settings).toEqual(r.settings);
  const comparison = compareReports(report() as any, saved, "instrumentation");
  expect(comparison.text).toContain(`Summary chars: unavailable -> ${chars}`);
  expect(comparison.text).toContain(`Summaries: unavailable -> ${counts}`);
  expect(comparison.text).toContain(`evidence in summary: 0/0 -> ${retained ? 1 : 0}/1`);
});
