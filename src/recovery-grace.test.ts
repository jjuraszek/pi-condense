import { describe, it, expect } from "bun:test";
import { inGraceRecoveryToolCallIds } from "./recovery-grace.js";
import { QUERY_TOOL_NAME } from "./types.js";

const user = () => ({ role: "user", content: [{ type: "text", text: "u" }] });
const ctq = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "context_tree_query", content: [{ type: "text", text: "x" }] });
const ctqAt = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "context_tree_query", content: [{ type: "text", text: "x" }], timestamp });
const bash = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "x" }] });
const nestedLookup = {
  complete: true,
  calls: [{ id: "inner", name: QUERY_TOOL_NAME, arguments: { ref: "t1" }, status: "ok" }],
};
const scripted = (id: string, timestamp: number, nestedCalls: unknown) => ({
  ...ctqAt(id, timestamp), toolName: "codemode", nestedCalls,
});

describe("inGraceRecoveryToolCallIds", () => {
  it.each([
    { label: "another outer tool", message: { ...scripted("script", 11, nestedLookup), toolName: "batch" }, key: "script@11" },
    { label: "incomplete record", message: scripted("script", 11, { ...nestedLookup, complete: false }), key: "script@11" },
    ...["error", "unfinished"].map((status) => ({
      label: `${status} lookup`,
      message: scripted("script", 11, { complete: false, calls: [{ ...nestedLookup.calls[0], status }] }), key: "script@11",
    })),
    { label: "several lookups", message: scripted("script", 11, { complete: true, calls: [nestedLookup.calls[0], { ...nestedLookup.calls[0], id: "second" }] }), key: "script@11" },
    { label: "direct and nested lookup", message: { ...ctqAt("script", 11), nestedCalls: nestedLookup }, key: "script@11" },
    { label: "no timestamp", message: { ...ctq("script"), toolName: "codemode", nestedCalls: nestedLookup }, key: "script" },
  ])("graces the whole recorded recovery occurrence: $label", ({ message, key }) => {
    expect([...inGraceRecoveryToolCallIds([user(), message], 3)]).toEqual([key]);
    expect([...inGraceRecoveryToolCallIds([user(), message, user(), user(), user(), user()], 3)]).toEqual([]);
  });

  for (const { label, age, graceTurns, expected } of [
    { label: "inclusive final turn", age: 3, graceTurns: 3, expected: ["direct@10", "script@11"] },
    { label: "first expired turn", age: 4, graceTurns: 3, expected: [] },
    { label: "zero disables grace", age: 0, graceTurns: 0, expected: [] },
  ]) {
    it(`scripted recovery window: ${label}`, () => {
      const msgs = [
        user(), ctqAt("direct", 10), scripted("script", 11, nestedLookup),
        ...Array.from({ length: age }, user),
      ];
      expect([...inGraceRecoveryToolCallIds(msgs, graceTurns)]).toEqual(expected);
    });
  }

  it.each([
    undefined,
    null,
    "malformed",
    42,
    {},
    { complete: true },
    { complete: true, calls: null },
    { complete: true, calls: {} },
    { complete: true, calls: QUERY_TOOL_NAME },
    { complete: true, calls: [] },
    { complete: false, calls: [] },
    { complete: true, calls: [null, {}, { name: 42 }] },
    { complete: true, calls: [{ id: "inner", name: "read", status: "ok" }] },
    { complete: false, calls: [{ id: "inner", name: "read", status: "unfinished" }] },
    { complete: true, calls: [{ name: "context_tree_query2" }] },
    { complete: true, calls: [{ name: "Context_Tree_Query" }] },
    { complete: true, calls: [{ name: "bash", arguments: { command: QUERY_TOOL_NAME } }] },
  ])("ignores scripts without a recorded lookup: %j", (nestedCalls) => {
    const script = scripted("script", 11, nestedCalls);
    script.content = [{ type: "text", text: QUERY_TOOL_NAME }];
    expect([...inGraceRecoveryToolCallIds([user(), script, ctqAt("direct", 10)], 3)])
      .toEqual(["direct@10"]);
  });

  it("isolates a scripted lookup from a reused ID at a different timestamp", () => {
    const msgs = [
      user(), scripted("X", 11, nestedLookup),
      user(), scripted("X", 20, { complete: true, calls: [] }),
    ];
    expect([...inGraceRecoveryToolCallIds(msgs, 3)]).toEqual(["X@11"]);
  });

  it("includes a recovery output in the current user-turn-group (age 0)", () => {
    const msgs = [user(), ctq("t1")];
    expect([...inGraceRecoveryToolCallIds(msgs, 3)]).toEqual(["t1"]);
  });
  it("includes a recovery output exactly K user-turns old", () => {
    const msgs = [user(), ctq("t1"), user(), user(), user()];
    expect(inGraceRecoveryToolCallIds(msgs, 3).has("t1")).toBe(true);
  });
  it("excludes a recovery output older than K user-turns", () => {
    const msgs = [user(), ctq("t1"), user(), user(), user(), user()];
    expect(inGraceRecoveryToolCallIds(msgs, 3).has("t1")).toBe(false);
  });
  it("returns empty set when grace disabled (K=0)", () => {
    const msgs = [user(), ctq("t1")];
    expect(inGraceRecoveryToolCallIds(msgs, 0).size).toBe(0);
  });
  it("ignores non-recovery tool outputs", () => {
    const msgs = [user(), bash("t1"), ctq("t2")];
    expect([...inGraceRecoveryToolCallIds(msgs, 3)]).toEqual(["t2"]);
  });
  it("judges multiple recovery outputs by their own positions", () => {
    const msgs = [user(), ctq("t1"), user(), user(), user(), user(), ctq("t2")];
    const set = inGraceRecoveryToolCallIds(msgs, 3);
    expect(set.has("t1")).toBe(false);
    expect(set.has("t2")).toBe(true);
  });
  it("keys a timestamped recovery output by occurrence (id@timestamp), not the bare id", () => {
    const msgs = [user(), ctqAt("reused", 100)];
    const set = inGraceRecoveryToolCallIds(msgs, 3);
    expect(set.has("reused@100")).toBe(true);
    expect(set.has("reused")).toBe(false);
  });
  it("does not conflate two occurrences of the same reused bare id", () => {
    const msgs = [user(), ctqAt("reused", 100), user(), user(), user(), user(), ctqAt("reused", 200)];
    const set = inGraceRecoveryToolCallIds(msgs, 3);
    expect(set.has("reused@100")).toBe(false);
    expect(set.has("reused@200")).toBe(true);
  });
});
