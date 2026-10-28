import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { PIPELINE_SETTINGS, settingsHash, stableHash, corpusHash, SUBJECT_SYSTEM_PROMPT, subjectPromptHash, SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, SUMMARIZER_MODELS, JUDGE_MODEL, RUNS_PER_CASE, DEFAULT_CONCURRENCY, RETRY_POLICY, concurrency } from "./config";
import type { Scenario } from "./scenario";

export const scenarios: Scenario[] = await Promise.all(
  readdirSync(`${import.meta.dir}/scenarios`).filter(p => p.endsWith(".ts")).sort().map(async p => {
    const scenario = (await import(`./scenarios/${p}`)).default;
    expect(scenario.id).toBe(p.slice(0, -3));
    return scenario;
  }),
);

const ids = ["approval-boundary", "correction-then-topic-change", "disproved-explanation", "failed-fix-not-disproof", "mid-result-fact", "repeated-attempts-among-unrelated", "unverified-hypothesis"];
describe("frozen corpus", () => {
  test("covers seven distinct contracts and preserves the release test script", () => {
    expect(scenarios.map(s => s.id)).toEqual(ids);
    expect(new Set(scenarios.map(s => s.id)).size).toBe(7);
    expect(JSON.parse(readFileSync(`${import.meta.dir}/../package.json`, "utf8")).scripts.test).toBe("bun test src/");
  });
  test.each(ids)("%s has eligible, synthetic, bounded evidence", id => {
    const s = scenarios.find(s => s.id === id)!;
    expect(s.tests.trim().length).toBeGreaterThan(30);
    expect(s.probe.trim().length).toBeGreaterThan(10);
    expect((s.mechanical.contains?.length ?? 0) + (s.mechanical.recovers?.length ?? 0) + (s.judged ? 1 : 0)).toBeGreaterThan(0);
    if (s.judged) {
      expect(s.judged.oracle.length).toBeGreaterThan(30);
      expect(s.judged.expected.length).toBeGreaterThan(30);
    }
    const fixture = JSON.stringify(s);
    expect(fixture).not.toMatch(/\/Users\/|@|sk-|ghp_|https?:|\b[\w-]+\.(com|net|org|io)\b/);
    let group = 0;
    const groups: number[] = [];
    const results: string[] = [];
    for (const turn of s.history) {
      if (turn.role === "user") { groups.push(group); group = 0; }
      if (turn.role === "result") {
        expect(turn.text.length).toBeGreaterThanOrEqual(3000);
        expect(turn.text.length).toBeLessThan(PIPELINE_SETTINGS.spillThreshold);
        results.push(turn.text);
        group += turn.text.length;
      }
      if (turn.role === "assistant") for (const call of turn.toolCalls ?? []) {
        const path = String(call.arguments.path ?? "");
        expect(PIPELINE_SETTINGS.protectedPaths.some(pattern => new Bun.Glob(pattern).match(path))).toBe(false);
      }
    }
    groups.push(group);
    expect(groups.some(n => n >= PIPELINE_SETTINGS.minBatchChars * 1.5)).toBe(true);
    expect(new Set(results).size).toBe(results.length);
    expect(fixture.length).toBeLessThan(100000);
  });
  test("middle fact cannot leak through head, tail, or probe", () => {
    const s = scenarios.find(s => s.id === "mid-result-fact")!;
    const result = s.history.find(t => t.role === "result")!;
    if (result.role !== "result") throw new Error("missing result");
    expect(result.text.length).toBe(12000);
    expect(result.text.indexOf("retry_window_ms=7319")).toBeGreaterThan(4000);
    expect(result.text.indexOf("retry_window_ms=7319")).toBeLessThan(8000);
    expect(JSON.stringify({ ...s, history: s.history.filter(t => t !== result), mechanical: {} })).not.toContain("7319");
    expect(s.mechanical).toEqual({ contains: ["7319"], recovers: [{ id: "call_mid-result-fact_1", evidence: "retry_window_ms=7319" }] });
  });
  test("repeated attempts require all three originals", () => {
    const s = scenarios.find(s => s.id === "repeated-attempts-among-unrelated")!;
    expect(s.mechanical.contains).toEqual(["A-SCAN", "A-REINDEX", "A-REPLAY"]);
    expect(s.mechanical.recovers?.map(r => r.id)).toEqual([1, 3, 5].map(n => `call_${s.id}_${n}`));
  });
  test("pins model identities, concurrency, retries, and independent pipeline defaults", () => {
    expect([SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, JUDGE_MODEL, RUNS_PER_CASE, DEFAULT_CONCURRENCY]).toEqual(["anthropic/claude-sonnet-5-5", "medium", "anthropic/claude-opus-5-5", 3, 8]);
    expect(SUMMARIZER_MODELS).toEqual(["anthropic/claude-haiku-5-5", "github-copilot/gpt-6-luna"]);
    expect(RETRY_POLICY).toEqual({ retries: 2, backoffMs: [2000, 8000], only: ["http-429", "transport"] });
    expect(concurrency({})).toBe(8);
    expect(concurrency({ EVAL_CONCURRENCY: "2" })).toBe(2);
    expect(() => concurrency({ EVAL_CONCURRENCY: "0" })).toThrow();
    expect(PIPELINE_SETTINGS).toEqual({
      enabled: true, showPruneStatusLine: true, summarizerModel: "", summarizerThinking: "default",
      pruneOn: "agent-message", batchingMode: "turn", quietOversizedSkips: false,
      minBatchChars: 2000, recoveryGraceTurns: 3, summarizerIdleTimeoutMs: 45000, summarizerMaxTimeoutMs: 180000,
      protectedTools: [], protectedPaths: ["**/skills/**/*.md", "**/gauntlet-overrides.md"],
      chainCompression: { enabled: true, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: true },
      purgeErrors: { enabled: true, cooldownTurns: 2, minArgChars: 500 }, dedupByContentHash: true,
      autoBudgetThreshold: null, spillThreshold: 65536, spillPreviewBytes: 2048,
      budgetTurnDelta: null, frontierGapThresholdTokens: null, maxImagesPerRequest: null,
    });
  });
  test("hashes sort keys, blank only summarizer, and bind corpus paths and bytes", () => {
    expect(stableHash({ b: 2, a: { d: 4, c: 3 } })).toBe(stableHash({ a: { c: 3, d: 4 }, b: 2 }));
    expect(settingsHash({ ...PIPELINE_SETTINGS, summarizerModel: "other" })).toBe(settingsHash());
    expect(settingsHash({ ...PIPELINE_SETTINGS, minBatchChars: 2001 })).not.toBe(settingsHash());
    expect(subjectPromptHash()).toBe(require("node:crypto").createHash("sha256").update(SUBJECT_SYSTEM_PROMPT).digest("hex"));
    expect(corpusHash([{ path: "b", bytes: "2" }, { path: "a", bytes: "1" }])).toBe(corpusHash([{ path: "a", bytes: "1" }, { path: "b", bytes: "2" }]));
    expect(corpusHash([{ path: "a", bytes: "1" }])).not.toBe(corpusHash([{ path: "b", bytes: "1" }]));
  });
});
