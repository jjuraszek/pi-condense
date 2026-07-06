import { describe, it, expect } from "bun:test";
import { inGraceRecoveryToolCallIds } from "./recovery-grace.js";

const user = () => ({ role: "user", content: [{ type: "text", text: "u" }] });
const ctq = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "context_tree_query", content: [{ type: "text", text: "x" }] });
const bash = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "x" }] });

describe("inGraceRecoveryToolCallIds", () => {
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
});
