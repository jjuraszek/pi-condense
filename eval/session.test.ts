import { expect, test } from "bun:test";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { seedEntries } from "./scenario";
import { scenarios } from "./scenarios.test";
import { idleFlushIndexed, assertIdleRequest } from "./session";
import type { Scenario } from "./scenario";

test.each(scenarios)("$id seeds a complete traversable session without orphan calls", s => {
  const endMs = Date.UTC(2026, 10, 17);
  const entries = seedEntries(s.history, endMs);
  expect(entries).toEqual(seedEntries(s.history, endMs));
  expect(entries[0]).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION });
  const branch = SessionManager.inMemory("/orbital-ledger", undefined, entries).getBranch();
  expect(branch.length).toBe(s.history.length);
  expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  const calls = new Map<string, string>();
  const results: string[] = [];
  branch.forEach((entry, i) => {
    expect(entry.parentId).toBe(i === 0 ? null : branch[i - 1].id);
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    if (entry.type !== "message") throw new Error("expected message");
    const m = entry.message;
    expect(m.content.length).toBeGreaterThan(0);
    expect(typeof m.timestamp).toBe("number");
    if (m.role === "assistant") {
      expect(m).toMatchObject({ model: "claude-sonnet-5-5", provider: "anthropic", api: "anthropic-messages" });
      expect(m.stopReason).toBe(m.content.some(c => c.type === "toolCall") ? "toolUse" : "stop");
      expect(m.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
      for (const c of m.content) if (c.type === "toolCall") {
        expect(c.id).toBe(`call_${s.id}_${calls.size + 1}`);
        expect(c.name.length).toBeGreaterThan(0);
        expect(typeof c.arguments).toBe("object");
        calls.set(c.id, c.name);
      }
    }
    if (m.role === "toolResult") {
      expect(calls.get(m.toolCallId)).toBe(m.toolName);
      expect(typeof m.isError).toBe("boolean");
      results.push(m.toolCallId);
    }
  });
  expect(results.sort()).toEqual([...calls.keys()].sort());
});

test("runJob preserves empty retention observations on an isolation failure", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runJob } = await import("./session");
  const jobPath = await mkdtemp(join(tmpdir(), "condense-retention-"));
  const result = await runJob({ scenario: scenarios[0], summarizer: "invalid-offline-model", runIndex: 0, jobPath, operatorAgentDir: jobPath, repo: process.cwd() });
  expect(result.errorReason).toBe("error:isolation");
  expect(result.summaries).toEqual([]);
  expect(result.flushMetrics).toEqual([]);
  const saved = JSON.parse(await readFile(join(jobPath, "job.json"), "utf8"));
  expect(saved.summaries).toEqual(result.summaries);
  expect(saved.flushMetrics).toEqual(result.flushMetrics);
});

const idleScenario: Scenario = {
  id: "proof", title: "proof", tests: "proof", probe: "Continue", mechanical: {}, unsummarizedIds: ["tiny"],
  history: [
    { role: "user", text: "Start" },
    { role: "assistant", toolCalls: [
      { id: "protected", name: "read", arguments: { path: "/orbital-ledger/skills/x/SKILL.md" } },
      { id: "tiny", name: "plan_tracker", arguments: {} },
      { id: "summarized", name: "read", arguments: { path: "/orbital-ledger/work.txt" } },
    ] },
    ...["protected", "tiny", "summarized"].map(id => ({ role: "result" as const, toolCallId: id, toolName: id === "tiny" ? "plan_tracker" : "read", text: `${id} original text` })),
    { role: "assistant", text: "Done", stopReason: "error" },
  ],
};
const refMap = new Map([["t1", "summarized"]]);
const summaries = [{ content: "Retained summary" }];
const seeded = seedEntries(idleScenario.history, 10000).filter(e => e.type === "message").map(e => e.message);
const resultMessage = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });
const outside = [resultMessage("protected", "protected original text"), resultMessage("tiny", "tiny original text"), resultMessage("summarized", "[Summarized in pruner summary, ref `t1`. Use context_tree_query to retrieve full output.]"), { role: "user", content: "Retained summary" }];
const chain = { type: "custom", customType: "context-prune-chain", data: { blockId: "b1", startUserTimestamp: seeded[0].timestamp, droppedToolCallIds: ["protected", "tiny", "summarized"] } };
const inside = [{ role: "user", content: '<compressed-chain id="b1">Retained summary\n<protected-output>protected original text</protected-output>\n<protected-output>tiny original text</protected-output></compressed-chain>' }];

test.each([
  { label: "expected index", refs: refMap, valid: true },
  { label: "protected indexed", refs: new Map([...refMap, ["t2", "protected"]]), valid: false },
  { label: "never summarized indexed", refs: new Map([...refMap, ["t2", "tiny"]]), valid: false },
  { label: "summary unindexed", refs: new Map(), valid: false },
])("idle flush class proof: $label", ({ refs, valid }) => {
  expect(idleFlushIndexed(idleScenario, refs)).toBe(valid);
});

test.each([
  { label: "raw protected and tiny, stub summary", paused: false, outgoing: outside },
  { label: "all compressed with protected text", paused: true, outgoing: inside },
  { label: "relocated blocks with tool attributes", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replaceAll("<protected-output>", '<protected-output tool="read">') }] },
  { label: "protected text in unrelated message only", paused: false, outgoing: [...outside.slice(1), { role: "user", content: "protected original text" }], error: "error:not-pruned" },
  { label: "protected text in unrelated result only", paused: false, outgoing: [...outside.slice(1), resultMessage("unrelated", "protected original text")], error: "error:not-pruned" },
  { label: "protected text in unrelated chain only", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("protected original text", "") }, { role: "user", content: '<compressed-chain id="b2"><protected-output>protected original text</protected-output></compressed-chain>' }], error: "error:not-pruned" },
  { label: "protected text in unwrapped chain body only", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("<protected-output>protected original text</protected-output>", "protected original text") }], error: "error:not-pruned" },
  { label: "protected text missing", paused: false, outgoing: outside.slice(1), error: "error:not-pruned" },
  { label: "protected text missing inside", paused: true, outgoing: [{ role: "user", content: '<compressed-chain id="b1">Retained summary</compressed-chain>' }], error: "error:not-pruned" },
  { label: "tiny raw missing", paused: false, outgoing: outside.filter(m => (m as any).toolCallId !== "tiny"), error: "error:not-pruned" },
  { label: "tiny text in unrelated message only", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("tiny original text", "") }, { role: "user", content: "tiny original text" }], error: "error:not-pruned" },
  { label: "tiny text in unwrapped chain body only", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("<protected-output>tiny original text</protected-output>", "tiny original text") }], error: "error:not-pruned" },
  { label: "tiny retained text missing", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("tiny original text", "") }], error: "error:not-pruned" },
  { label: "tiny retained text altered", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("tiny original text", "tiny changed text") }], error: "error:not-pruned" },
  { label: "tiny retained in another chain only", paused: true, outgoing: [{ ...inside[0], content: inside[0].content.replace("tiny original text", "") }, { role: "user", content: '<compressed-chain id="b2"><protected-output>tiny original text</protected-output></compressed-chain>' }], error: "error:not-pruned" },
  { label: "tiny standalone despite relocation", paused: true, outgoing: [...inside, resultMessage("tiny", "tiny original text")], error: "error:not-pruned" },
  { label: "summary raw", paused: false, outgoing: [...outside, resultMessage("summarized", "summarized original text")], error: "error:not-pruned" },
  { label: "summary neither stub nor chain", paused: false, outgoing: outside.filter(m => (m as any).toolCallId !== "summarized"), error: "error:not-pruned" },
  { label: "paused raw chain", paused: true, outgoing: outside, error: "error:idle-arm" },
  { label: "fresh compressed chain", paused: false, outgoing: inside, error: "error:idle-arm" },
])("idle request class proof: $label", ({ paused, outgoing, error }) => {
  const scenario = { ...idleScenario, ...(paused ? { twinOf: "fresh" } : {}) };
  const check = () => assertIdleRequest({ scenario, seeded, branch: [chain], outgoing, refMap, summaries });
  if (error) expect(check).toThrow(error);
  else expect(check).not.toThrow();
});

test("seeded interrupted assistant closes with its stated stop reason", () => {
  expect((seeded.at(-1) as any).stopReason).toBe("error");
});
