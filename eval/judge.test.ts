import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildShortRefMap, judgePromptHash, JUDGE_PROMPT, score, type ToolObservation } from "./judge.js";
import type { Scenario } from "./scenario.js";
import { observe } from "./observer.js";

const scenario: Scenario = { id: "test", title: "test", tests: "test", history: [{ role: "user", text: "SECRET RAW HISTORY" }], probe: "What value?", mechanical: { contains: ["42"], recovers: [{ id: "call_a", evidence: "value=42" }] } };
const refs = buildShortRefMap([
  { type: "custom", customType: "context-prune-index", data: { backfilled: true, refs: [{ shortId: "t1", toolCallId: "call_a" }] } },
  { type: "custom_message", customType: "context-prune-summary", details: { toolCallRefs: [{ shortId: "t2", toolCallId: "call_b" }] } },
]);
const hit = (ids = ["call_a"], result = "## toolRef: call_a\nTool: read\nvalue=42"): ToolObservation => ({ name: "context_tree_query", arguments: { toolCallIds: ids }, result, index: 1, resultIndex: 2, toolCallId: "query_1" });
function stub(outputs: string[] = []) {
  const calls: any[] = [];
  const models: any[] = [];
  return { calls, models, runtime: {
    getModel(...args: any[]) { models.push(args); return { provider: "anthropic", id: "claude-opus-5-5" } as any; },
    async completeSimple(...args: any[]) { calls.push(args); return { content: [{ type: "text", text: outputs.shift() ?? "{}" }], stopReason: "stop" } as any; },
  } };
}
function run(toolCalls: ToolObservation[], reply = "42", s = scenario, runtime = stub().runtime) {
  return score({ scenario: s, reply, toolCalls, finalAssistantIndex: 5, shortRefMap: refs, runtime });
}

describe("recovery source and completion gates", () => {
  test.each([
    ["raw hit", [hit()], "42", "hit", "pass"],
    ["alias hit", [hit(["t1"], "## toolRef: t1\nvalue=42")], "42", "hit", "pass"],
    ["raw call alias label", [hit(["call_a"], "## toolRef: t1\nvalue=42")], "42", "hit", "pass"],
    ["not found", [hit(["call_a"], "## toolRef: call_a\n(not found in index)")], "42", "not-found", "fail"],
    ["wrong source", [hit(["call_a"], "## toolRef: call_b\nvalue=42")], "42", "wrong-source", "fail"],
    ["missing evidence", [hit(["call_a"], "## toolRef: call_a\nempty")], "42", "wrong-source", "fail"],
    ["late result", [{ ...hit(), resultIndex: 6 }], "42", "no-call", "fail"],
    ["result at final", [{ ...hit(), resultIndex: 5 }], "42", "no-call", "fail"],
    ["unrequested source", [hit(["call_b"])], "42", "no-call", "fail"],
    ["late call", [{ ...hit(), index: 6, resultIndex: 7 }], "42", "no-call", "fail"],
    ["no call", [], "42", "no-call", "fail"],
    ["wrong tool", [{ ...hit(), name: "read" }], "42", "no-call", "fail"],
    ["hit without answer", [hit()], "unknown", "hit", "fail"],
    ["multi-id misplaced evidence", [hit(["call_a", "call_b"], "## toolRef: call_a\nempty\n\n---\n\n## toolRef: call_b\nvalue=42")], "42", "wrong-source", "fail"],
    ["miss then hit", [hit(["call_a"], "## toolRef: call_a\n(not found in index)"), { ...hit(), index: 3, resultIndex: 4 }], "42", "hit", "pass"],
  ] as const)("%s", async (_name, calls, reply, outcome, status) => {
    const result = await run([...calls], reply);
    expect(result.status).toBe(status);
    expect(result.recovery).toEqual([{ id: "call_a", outcome }]);
    if (status === "fail") expect(result.check).toBe(outcome === "hit" ? "contains:42" : `recovers:call_a:${outcome}`);
  });
  test("requires every recovery and resolves real summary metadata", async () => {
    expect(refs.get("t2")).toBe("call_b");
    const s = { ...scenario, mechanical: { recovers: ["call_a", "call_b", "call_c"].map(id => ({ id, evidence: "42" })) } };
    const result = await run([hit(["call_a", "t2"], "## toolRef: call_a\n42\n## toolRef: t2\n42")], "42", s);
    expect(result.check).toBe("recovers:call_c:no-call");
  });
});

const judged = { ...scenario, mechanical: { contains: ["42"] }, judged: { oracle: "The user corrected 24 to 42.", expected: "Use 42; reject 24." } };
test("correction reaches frozen judge without raw history or temperature", async () => {
  const mock = stub(['{"pass":true,"reason":"Rejects the old value."}']);
  const reply = "use 42; my earlier 24 was wrong";
  const observed = observe({ ...mock.runtime, streamSimple() { throw new Error("unused"); } });
  observed.setPhase("judge");
  expect((await run([], reply, judged, observed.runtime)).status).toBe("pass");
  expect(observed.records).toHaveLength(1);
  expect(observed.records[0].phase).toBe("judge");
  expect(mock.models).toEqual([["anthropic", "claude-opus-5-5"]]);
  const [, context, options] = mock.calls[0];
  expect(context.systemPrompt).toBe(JUDGE_PROMPT);
  expect(JSON.parse(context.messages[0].content)).toEqual({ ...judged.judged, probe: judged.probe, reply, toolCalls: [] });
  expect(JSON.stringify(context)).not.toContain("SECRET RAW HISTORY");
  expect(options?.temperature).toBeUndefined();
  expect(judgePromptHash()).toBe(createHash("sha256").update(JUDGE_PROMPT).digest("hex"));
  for (const word of ["assertion", "quotation", "negation", "correction", "approval", "unsupported"]) expect(JUDGE_PROMPT).toContain(word);
});
test("unsupported claims use judge verdict; mechanical failure skips judge", async () => {
  const mock = stub(['{"pass":false,"reason":"Unsupported cause asserted."}']);
  expect(await run([], "42 because of aliens", judged, mock.runtime)).toMatchObject({ status: "fail", check: "judge", reason: "Unsupported cause asserted." });
  expect((await run([], "24", judged, mock.runtime)).check).toBe("contains:42");
  expect(mock.calls).toHaveLength(1);
});
test.each(["not json", '{"pass":"yes","reason":"ok"}', '{"pass":true,"reason":4}', '{"pass":true,"reason":"  "}',
  'Prose {"pass":true,"reason":"ok"}',
  '```json\n{"pass":true,"reason":"ok"}\n``` trailing',
  '```json\n{"pass":true,"reason":"ok"}\n```\n```json\n{}\n```',
  '```json\n{"pass":true,"reason":"  "}\n```',
  '```json\n{"pass":"yes","reason":"ok"}\n```',
])("invalid judge response retries only once: %s", async bad => {
  const mock = stub([bad, bad, '{"pass":true,"reason":"unused"}']);
  expect(await run([], "42", judged, mock.runtime)).toMatchObject({ status: "error", check: "judge", reason: "error: judge" });
  expect(mock.calls).toHaveLength(2);
});
test.each([
  ["plain", '{"pass":false,"reason":"Unsupported claim."}'],
  ["json fence", '```json\n{"pass":false,"reason":"Unsupported claim."}\n```'],
  ["bare fence", '```\n{"pass":false,"reason":"Unsupported claim."}\n```'],
  ["CRLF and whitespace", ' \r\n```json\r\n  {"pass":false,"reason":"Unsupported claim."}\r\n```\r\n '],
])("accepts entire verdict: %s", async (_name, text) => {
  const mock = stub([text]);
  expect(await run([], "42", judged, mock.runtime)).toMatchObject({ status: "fail", reason: "Unsupported claim." });
  expect(mock.calls).toHaveLength(1);
});
test("mechanical-only success never resolves or invokes judge", async () => {
  const mock = stub();
  expect((await run([hit()], "42", scenario, mock.runtime)).status).toBe("pass");
  expect(mock.models).toHaveLength(0);
  expect(mock.calls).toHaveLength(0);
});
test("malformed then valid succeeds", async () => {
  const mock = stub(["oops", '{"pass":true,"reason":"Corrected value."}']);
  expect((await run([], "42", judged, mock.runtime)).status).toBe("pass");
  expect(mock.calls).toHaveLength(2);
});
test("provider errors expose a safe class, not credentials", async () => {
  const mock = stub();
  mock.runtime.completeSimple = async () => { throw Object.assign(new Error("secret token"), { status: 429 }); };
  expect(await run([], "42", judged, mock.runtime)).toMatchObject({ status: "error", check: "judge", reason: "error: provider:http-429" });
});
