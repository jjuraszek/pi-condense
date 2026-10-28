import { expect, test } from "bun:test";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { seedEntries } from "./scenario";
import { scenarios } from "./scenarios.test";

test.each(scenarios)("$id seeds a complete traversable session without orphan calls", s => {
  const entries = seedEntries(s.history);
  expect(entries).toEqual(seedEntries(s.history));
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
