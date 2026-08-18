import { describe, expect, test } from "bun:test";
import { sweepOrphanToolResults } from "./orphan-sweep.js";
import { expectNoOrphanToolResults } from "./test-support.js";

const asst = (ts: number, ids: string[]) => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "toolCall", id, name: "bash", input: {} })),
  timestamp: ts,
});
const res = (ts: number, id: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: ts,
});
const user = (ts: number) => ({ role: "user", content: [{ type: "text", text: "go" }], timestamp: ts });

describe("sweepOrphanToolResults", () => {
  test("returns the SAME array reference when there is no orphan", () => {
    const msgs = [user(1), asst(2, ["a"]), res(3, "a")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.messages).toBe(msgs);
    expect(out.sweptIds).toEqual([]);
  });

  test("removes a toolResult whose call was never opened", () => {
    const msgs = [user(1), asst(2, ["a"]), res(3, "a"), res(4, "ghost")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.sweptIds).toEqual(["ghost"]);
    expect(out.messages).toHaveLength(3);
    expect(out.messages.some((m: any) => m.toolCallId === "ghost")).toBe(false);
  });

  test("open-call tracking is per turn: a validly used id does not license a later orphan", () => {
    // 'a' is opened and consumed in turn 1; the later 'a' result has no opener
    const msgs = [user(1), asst(2, ["a"]), res(3, "a"), asst(4, ["b"]), res(5, "b"), res(6, "a")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.sweptIds).toEqual(["a"]);
    expect(out.messages).toHaveLength(5);
  });

  test("legitimate reuse of the same bare id across turns is kept, not swept", () => {
    const msgs = [asst(1, ["a"]), res(2, "a"), asst(3, ["a"]), res(4, "a")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.sweptIds).toEqual([]);
    expect(out.messages).toBe(msgs);
    expect(out.messages).toHaveLength(4);
  });

  test("a duplicate result for one call is swept (id consumed once)", () => {
    const msgs = [asst(1, ["a"]), res(2, "a"), res(3, "a")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.sweptIds).toEqual(["a"]);
    expect(out.messages).toHaveLength(2);
  });

  test("keeps results for every id of a multi-call assistant turn", () => {
    const msgs = [asst(1, ["a", "b"]), res(2, "a"), res(3, "b")];
    expect(sweepOrphanToolResults(msgs).messages).toBe(msgs);
  });

  // AC1: any non-assistant/non-toolResult role is a barrier - including an
  // unknown role, so a role-allowlist implementation cannot pass.
  const barrierRoles: Array<[string, any]> = [
    ["custom", { role: "custom", customType: "x", timestamp: 2 }],
    ["user", user(2)],
    ["branchSummary", { role: "branchSummary", timestamp: 2 }],
    ["compactionSummary", { role: "compactionSummary", timestamp: 2 }],
    ["bashExecution", { role: "bashExecution", timestamp: 2 }],
    ["unknown future role", { role: "future-role", timestamp: 2 }],
  ];
  for (const [name, barrier] of barrierRoles) {
    test(`a ${name} message between a call and its result is a barrier: the result is swept`, () => {
      const msgs = [asst(1, ["a"]), barrier, res(3, "a")];
      const out = sweepOrphanToolResults(msgs);
      expect(out.sweptIds).toEqual(["a"]);
      expect(out.messages).toHaveLength(2);
      expect(out.messages.some((m: any) => m.role === "toolResult")).toBe(false);
    });
  }

  // AC2: barrier clears only what is still open; results consumed before it stay.
  test("multi-call turn: barrier sweeps only the not-yet-consumed result", () => {
    const msgs = [asst(1, ["a", "b"]), res(2, "a"), { role: "custom", customType: "x", timestamp: 3 }, res(4, "b")];
    const out = sweepOrphanToolResults(msgs);
    expect(out.sweptIds).toEqual(["b"]);
    expect(out.messages).toHaveLength(3);
  });

  // AC3: a barrier after a completed cycle is untouched - same array reference.
  test("trailing barrier after a completed cycle is a no-op (same array reference)", () => {
    const msgs = [asst(1, ["a"]), res(2, "a"), { role: "custom", customType: "x", timestamp: 3 }];
    const out = sweepOrphanToolResults(msgs);
    expect(out.messages).toBe(msgs);
    expect(out.sweptIds).toEqual([]);
  });

  // AC5: the test helper enforces the same barrier rule (it copies the sweep's
  // orphan definition; delegation would make sweep tests tautological).
  test("expectNoOrphanToolResults throws on a mid-cycle barrier orphan and passes on a clean trailing barrier", () => {
    const bad = [asst(1, ["a"]), { role: "custom", customType: "x", timestamp: 2 }, res(3, "a")];
    expect(() => expectNoOrphanToolResults(bad)).toThrow();
    expectNoOrphanToolResults([asst(1, ["a"]), res(2, "a"), { role: "custom", customType: "x", timestamp: 3 }]);
  });
});
