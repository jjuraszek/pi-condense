import { describe, expect, test } from "bun:test";
import {
  applySupersede,
  createSupersedeState,
  earliestChainStart,
  earliestResultTimestamp,
  findSuperseded,
  lowerFloor,
  supersededStub,
  type SupersedeState,
} from "./supersede.js";
import { isProtected } from "./protected.js";
import { occKey } from "./occurrence-key.js";

const cfg = { protectedTools: ["phase_tracker"], protectedPaths: ["**/skills/**/*.md"] };
const prot = (name: string, args: unknown) => isProtected(name, args, cfg);

const SKILL = "/h/skills/x/SKILL.md";
const OTHER = "/h/skills/y/SKILL.md";

function call(id: string, ts: number, args: unknown, name = "read", argKey: "input" | "args" | "arguments" = "input"): any[] {
  return [
    { role: "assistant", timestamp: ts, content: [{ type: "toolCall", id, name, [argKey]: args }] },
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: `BODY-${id}` }], isError: false, timestamp: ts + 1 },
  ];
}

describe("findSuperseded", () => {
  test("single protected read -> []", () => {
    expect(findSuperseded(call("a", 10, { path: SKILL }), prot)).toEqual([]);
  });

  test("A < B same path -> [A]", () => {
    const msgs = [...call("a", 10, { path: SKILL }), ...call("b", 20, { path: SKILL })];
    const out = findSuperseded(msgs, prot);
    expect(out.map((c) => c.toolCallId)).toEqual(["a"]);
    expect(out[0]).toEqual({ toolCallId: "a", path: SKILL, timestamp: 11, resultIndex: 1 });
  });

  test("A < B < C -> [A, B]", () => {
    const msgs = [...call("a", 10, { path: SKILL }), ...call("b", 20, { path: SKILL }), ...call("c", 30, { path: SKILL })];
    expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a", "b"]);
  });

  test("different offset/limit slices of one path -> older is a candidate", () => {
    const msgs = [...call("a", 10, { path: SKILL, offset: 1, limit: 400 }), ...call("b", 20, { path: SKILL, offset: 400, limit: 50 })];
    expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a"]);
  });

  test("two paths interleaved -> per-path winners and candidates", () => {
    const msgs = [
      ...call("a1", 10, { path: SKILL }),
      ...call("b1", 20, { path: OTHER }),
      ...call("a2", 30, { path: SKILL }),
      ...call("b2", 40, { path: OTHER }),
    ];
    expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a1", "b1"]);
  });

  test("protected call without path -> ignored", () => {
    const msgs = [...call("t1", 10, {}, "phase_tracker"), ...call("t2", 20, {}, "phase_tracker")];
    expect(findSuperseded(msgs, prot)).toEqual([]);
  });

  test("unprotected read of the same path -> neither candidate nor winner", () => {
    // bash's real args carry `command`, not `path` (protected.test.ts: "does not infer paths from bash commands");
    // isProtected matches path globs regardless of tool name, so a synthetic `path` arg here would wrongly qualify.
    const msgs = [...call("a", 10, { path: SKILL }), ...call("u", 20, { command: `cat ${SKILL}` }, "bash")];
    expect(findSuperseded(msgs, prot)).toEqual([]);
  });

  test("backslash path equals forward-slash path", () => {
    const msgs = [...call("a", 10, { path: "\\h\\skills\\x\\SKILL.md" }), ...call("b", 20, { path: SKILL })];
    expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a"]);
  });

  test("newest call without a paired result does not participate; previous read wins", () => {
    const msgs = [
      ...call("a", 10, { path: SKILL }),
      ...call("b", 20, { path: SKILL }),
      { role: "assistant", timestamp: 30, content: [{ type: "toolCall", id: "c", name: "read", input: { path: SKILL } }] },
    ];
    expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a"]);
  });

  test("missing result timestamp -> timestamp undefined, pairing still by id", () => {
    const msgs = [...call("a", 10, { path: SKILL }), ...call("b", 20, { path: SKILL })];
    delete msgs[1].timestamp;
    expect(findSuperseded(msgs, prot)[0]).toEqual({ toolCallId: "a", path: SKILL, timestamp: undefined, resultIndex: 1 });
  });

  test("args read from input / args / arguments shapes alike", () => {
    for (const key of ["input", "args", "arguments"] as const) {
      const msgs = [...call("a", 10, { path: SKILL }, "read", key), ...call("b", 20, { path: SKILL }, "read", key)];
      expect(findSuperseded(msgs, prot).map((c) => c.toolCallId)).toEqual(["a"]);
    }
  });

  test("reused id with an interleaved non-participating call pairs each read with its own result", () => {
    const msgs = [
      ...call("X", 10, { path: SKILL }),                 // idx 0-1: protected read
      ...call("X", 20, { command: "echo hi" }, "bash"),  // idx 2-3: same id, not participating
      ...call("X", 30, { path: SKILL }),                 // idx 4-5: protected read
      ...call("X", 40, { path: SKILL }),                 // idx 6-7: protected read (winner)
    ];
    const out = findSuperseded(msgs, prot);
    expect(out.map((c) => [c.resultIndex, c.timestamp])).toEqual([[1, 11], [5, 31]]);
    const s = createSupersedeState();
    s.floor = 0;
    const pruned = applySupersede(msgs, s, prot);
    expect(pruned[3].content[0].text).toBe("BODY-X");   // bash result untouched
    expect(pruned[7].content[0].text).toBe("BODY-X");   // newest read untouched
    expect(pruned[1].content[0].text).toBe(supersededStub(SKILL));
    expect(pruned[5].content[0].text).toBe(supersededStub(SKILL));
  });

  test("aborted call under a reused id in the middle does not steal a later result", () => {
    const msgs = [
      ...call("X", 10, { path: SKILL }),                                                    // idx 0-1: only read of SKILL
      { role: "assistant", timestamp: 20, content: [{ type: "toolCall", id: "X", name: "read", input: { path: SKILL } }] }, // idx 2: aborted, no result
      ...call("X", 30, { path: OTHER }),                                                    // idx 3-4: only read of OTHER
    ];
    expect(findSuperseded(msgs, prot)).toEqual([]);
  });

  test("a result is paired only with the immediately preceding assistant turn", () => {
    const msgs = [
      { role: "assistant", timestamp: 10, content: [{ type: "toolCall", id: "X", name: "read", input: { path: SKILL } }] },
      { role: "user", timestamp: 15, content: [{ type: "text", text: "barrier" }] },
      { role: "toolResult", toolCallId: "X", toolName: "read", content: [{ type: "text", text: "STRAY" }], isError: false, timestamp: 16 },
      ...call("X", 20, { path: SKILL }),
    ];
    // the stray result after a barrier pairs with nothing; the turn-10 call has no result and does not participate
    expect(findSuperseded(msgs, prot)).toEqual([]);
  });

  test("the last occurrence per path is never returned (shuffled fixtures)", () => {
    const paths = [SKILL, OTHER, "/h/skills/z/SKILL.md"];
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let round = 0; round < 20; round++) {
      const msgs: any[] = [];
      const lastId = new Map<string, string>();
      for (let i = 0; i < 12; i++) {
        const p = paths[Math.floor(rnd() * paths.length)];
        const id = `r${round}-${i}`;
        msgs.push(...call(id, i * 10, { path: p }));
        lastId.set(p, id);
      }
      const returned = new Set(findSuperseded(msgs, prot).map((c) => c.toolCallId));
      for (const id of lastId.values()) expect(returned.has(id)).toBe(false);
    }
  });
});

describe("floor helpers", () => {
  test("lowerFloor sets when undefined, lowers monotonically, ignores undefined input", () => {
    const s = createSupersedeState();
    lowerFloor(s, undefined);
    expect(s.floor).toBeUndefined();
    lowerFloor(s, 500);
    expect(s.floor).toBe(500);
    lowerFloor(s, 900);
    expect(s.floor).toBe(500);
    lowerFloor(s, 100);
    expect(s.floor).toBe(100);
    lowerFloor(s, 0);
    expect(s.floor).toBe(0);
  });

  test("earliestResultTimestamp: min over defined timestamps, undefined when none", () => {
    expect(earliestResultTimestamp([{ resultTimestamp: 30 }, { resultTimestamp: 10 }, {}])).toBe(10);
    expect(earliestResultTimestamp([{}, {}])).toBeUndefined();
    expect(earliestResultTimestamp([])).toBeUndefined();
  });

  test("earliestChainStart: min startUserTimestamp, undefined when empty", () => {
    expect(earliestChainStart([{ startUserTimestamp: 300 }, { startUserTimestamp: 100 }])).toBe(100);
    expect(earliestChainStart([])).toBeUndefined();
  });
});

describe("applySupersede", () => {
  const two = () => [...call("a", 10, { path: SKILL }), ...call("b", 20, { path: SKILL })];

  test("floor undefined -> input reference returned, activated empty", () => {
    const s = createSupersedeState();
    const msgs = two();
    expect(applySupersede(msgs, s, prot)).toBe(msgs);
    expect(s.activated.size).toBe(0);
  });

  test("floor 0 -> candidate stubbed, newest byte-for-byte verbatim, input untouched", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = two();
    const before = JSON.stringify(msgs);
    const out = applySupersede(msgs, s, prot);
    expect(out).not.toBe(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
    expect(out[1]).toEqual({ ...msgs[1], content: [{ type: "text", text: supersededStub(SKILL) }] });
    expect(out[3]).toBe(msgs[3]);
    expect(s.floor).toBeUndefined();
    expect(s.activated.has(occKey("a", 11))).toBe(true);
  });

  test("stub text is the spec literal", () => {
    expect(supersededStub(SKILL)).toBe(
      `[Superseded: ${SKILL} was read again later in this conversation - see the newer read. Re-read the file if this earlier content is needed.]`,
    );
  });

  test("floor above candidate -> verbatim; lowered below -> stubbed; then undefined -> sticky", () => {
    const s = createSupersedeState();
    const msgs = two();
    s.floor = 15;
    expect(applySupersede(msgs, s, prot)).toBe(msgs);
    expect(s.floor).toBeUndefined();
    s.floor = 5;
    expect(applySupersede(msgs, s, prot)[1].content[0].text).toBe(supersededStub(SKILL));
    expect(s.floor).toBeUndefined();
    expect(applySupersede(msgs, s, prot)[1].content[0].text).toBe(supersededStub(SKILL));
  });

  test("floor exactly equal to candidate timestamp activates (>=)", () => {
    const s = createSupersedeState();
    const msgs = two();
    s.floor = 11;
    expect(applySupersede(msgs, s, prot)).not.toBe(msgs);
  });

  test("isProtected flips to false -> stub not applied even though key is activated", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = two();
    applySupersede(msgs, s, prot);
    const none = (_n: string, _a: unknown) => false;
    expect(applySupersede(msgs, s, none)).toBe(msgs);
  });

  test("newer read removed -> older read verbatim even though key is activated", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = two();
    applySupersede(msgs, s, prot);
    const onlyOld = msgs.slice(0, 2);
    expect(applySupersede(onlyOld, s, prot)).toBe(onlyOld);
  });

  test("candidate with undefined timestamp: not activated by positional floor, activated by floor 0", () => {
    const s = createSupersedeState();
    const msgs = two();
    delete msgs[1].timestamp;
    s.floor = 5;
    expect(applySupersede(msgs, s, prot)).toBe(msgs);
    s.floor = 0;
    const out = applySupersede(msgs, s, prot);
    expect(out[1].content[0].text).toBe(supersededStub(SKILL));
    expect(s.activated.has("a")).toBe(true);
  });

  test("same toolCallId reused across turns -> only the activated occurrence is stubbed", () => {
    const s = createSupersedeState();
    const msgs = [...call("dup", 10, { path: SKILL }), ...call("dup", 20, { path: SKILL }), ...call("dup", 30, { path: SKILL })];
    s.floor = 21;
    const out = applySupersede(msgs, s, prot);
    expect(out[1].content[0].text).toBe("BODY-dup");
    expect(out[3].content[0].text).toBe(supersededStub(SKILL));
    expect(out[5].content[0].text).toBe("BODY-dup");
    expect([...s.activated]).toEqual([occKey("dup", 21)]);
  });

  test("newest read errored still wins", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = two();
    msgs[3] = { ...msgs[3], isError: true, content: [{ type: "text", text: "ENOENT" }] };
    const out = applySupersede(msgs, s, prot);
    expect(out[1].content[0].text).toBe(supersededStub(SKILL));
    expect(out[3]).toBe(msgs[3]);
  });

  test("A < B < C: A and B stubbed, C verbatim", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = [...call("a", 10, { path: SKILL }), ...call("b", 20, { path: SKILL }), ...call("c", 30, { path: SKILL })];
    const out = applySupersede(msgs, s, prot);
    expect(out[1].content[0].text).toBe(supersededStub(SKILL));
    expect(out[3].content[0].text).toBe(supersededStub(SKILL));
    expect(out[5]).toBe(msgs[5]);
  });

  test("superseded candidate that had errored is stubbed with isError false", () => {
    const s = createSupersedeState();
    s.floor = 0;
    const msgs = two();
    msgs[1] = { ...msgs[1], isError: true, content: [{ type: "text", text: "EACCES" }] };
    const out = applySupersede(msgs, s, prot);
    expect(out[1].isError).toBe(false);
    expect(out[1].content[0].text).toBe(supersededStub(SKILL));
  });
});
