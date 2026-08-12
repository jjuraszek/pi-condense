import { describe, expect, test } from "bun:test";
import { sweepOrphanToolResults } from "./orphan-sweep.js";

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

  test("non-assistant messages between a call and its result do not close the open set", () => {
    const msgs = [asst(1, ["a"]), { role: "custom", customType: "x", timestamp: 2 }, res(3, "a")];
    expect(sweepOrphanToolResults(msgs).messages).toBe(msgs);
  });
});
