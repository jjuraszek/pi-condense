import { expect, test } from "bun:test";
import { oracleCandidates, oracleStrings } from "./oracle.js";
import type { ReplaySession } from "./extract.js";

export function session(text = "retry_window_ms=7319 src/foo.ts getBranch pi-condense v1.2.3\nerror: \"connection refused\""): ReplaySession {
  return { batches: [{ turnIndex: 0, timestamp: 0, assistantText: "", toolCalls: [{ toolCallId: "call", toolName: "bash", args: {}, resultText: text, isError: false }] }], messages: [{ position: 0, role: "user", text: "inspect", toolArgs: [] }, { position: 1, role: "assistant", text: "", toolArgs: [{}] }, { position: 3, role: "assistant", text, toolArgs: [] }], batchPositions: [{ assistantPosition: 1, results: [{ position: 2, occurrenceKey: "call", spilled: false }] }], counts: { sessionsRead: 1, sessionsSkipped: 0, batches: 1, longResults: 0, spillPresent: 0, spillMissing: 0, protectedExclusions: 0 } };
}

test("oracle uses identifier tokens, numbers, paths and clipped error evidence", () => {
  const s = session();
  expect([...oracleStrings(s).get(0)!]).toEqual(expect.arrayContaining(["retry_window_ms", "7319", "src/foo.ts", "getBranch", "pi-condense", "v1.2.3", '"connection refused"']));
  expect(oracleStrings(session("ordinary branch")).get(0)?.size).toBe(0);
  const long = 'error: "' + "q".repeat(250) + '"';
  expect(oracleCandidates(session(long)).get(0)!.some(c => c.text.length === 200)).toBe(true);
});

test.each(["user", "assistant", "argument", "own-text", "own-args"])("excludes earlier %s evidence", kind => {
  const s = session("learned_key=7319");
  if (kind === "own-text") s.batches[0].assistantText = "learned_key 7319";
  else if (kind === "own-args") s.batches[0].toolCalls[0].args = { learned_key: 7319 };
  else s.messages.unshift({ position: -1, role: kind === "user" ? "user" : "assistant", text: kind === "argument" ? "" : "learned_key 7319", toolArgs: kind === "argument" ? [{ learned_key: 7319 }] : [] });
  expect(oracleStrings(s).get(0)?.size).toBe(0);
});

test("later users cannot teach oracle; later arguments can, spills cannot", () => {
  const s = session("7319");
  s.messages[2].role = "user";
  expect(oracleStrings(s).get(0)?.size).toBe(0);
  s.messages[2] = { position: 3, role: "assistant", text: "", toolArgs: [{ value: 7319 }] };
  expect(oracleStrings(s).get(0)?.has("7319")).toBe(true);
  s.batchPositions[0].results[0].spilled = true;
  expect(oracleStrings(s).get(0)?.size).toBe(0);
});

test("first occurrence and multi-result branch boundaries use positions, not timestamps", () => {
  const s = session("7319 " + "x".repeat(4000) + " 7319 middle_key " + "x".repeat(4000));
  s.batches[0].toolCalls.push({ ...s.batches[0].toolCalls[0], toolCallId: "second", resultText: "7319 middle_key" });
  s.batchPositions[0].results.push({ position: 4, occurrenceKey: "second", spilled: false });
  s.messages[2].position = 5;
  s.messages.push({ position: 3, role: "assistant", text: "middle_key", toolArgs: [] });
  const entries = oracleCandidates(s).get(0)!;
  expect(entries.filter(c => c.text === "7319").map(c => [c.resultIndex, c.offset, c.inMiddle])).toEqual([[0, 0, false], [1, 0, false]]);
  expect(entries.find(c => c.text === "middle_key" && c.resultIndex === 0)?.inMiddle).toBe(true);
});
