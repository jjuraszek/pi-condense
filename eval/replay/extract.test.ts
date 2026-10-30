import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedEntries } from "../scenario";
import { extractSessions } from "./extract";

test("opens branch sessions, excludes protected calls and joins spills by occurrence", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-extract-"));
  const input = join(dir, "sessions");
  mkdirSync(input);
  const sidecar = join(dir, "sidecar");
  writeFileSync(sidecar, "private sidecar bytes");
  const entries = seedEntries([
    { role: "user", text: "ask" },
    { role: "assistant", text: "own text", toolCalls: [{ id: "same", name: "read", arguments: { path: "source.ts" } }, { id: "protected", name: "read", arguments: { path: "skills/test/info.md" } }] },
    { role: "result", toolCallId: "same", toolName: "read", text: "RAW-SPILL-PRESENT" },
    { role: "result", toolCallId: "protected", toolName: "read", text: "PROTECTED" },
    { role: "assistant", toolCalls: [{ id: "same", name: "read", arguments: {} }] },
    { role: "result", toolCallId: "same", toolName: "read", text: "RAW-SPILL-MISSING" },
    { role: "assistant", toolCalls: [{ id: "same", name: "read", arguments: {} }] },
    { role: "result", toolCallId: "same", toolName: "read", text: "x".repeat(70000) },
    { role: "assistant", text: "later evidence" },
  ]);
  entries.push({ type: "custom", id: "index", parentId: "seed-message-9", timestamp: new Date().toISOString(), customType: "context-prune-index", data: { toolCalls: [
    { toolCallId: "same", resultTimestamp: Date.UTC(2026, 0, 1) + 2000, spillPath: sidecar },
    { toolCallId: "same", resultTimestamp: Date.UTC(2026, 0, 1) + 5000, spillPath: join(dir, "missing") },
  ] } });
  writeFileSync(join(input, "one.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(input, "two.jsonl"), seedEntries([{ role: "user", text: "empty session" }]).map(e => JSON.stringify(e)).join("\n"));
  mkdirSync(join(input, "unreadable.jsonl"));
  const outsideChild = join(dir, "child");
  mkdirSync(outsideChild);
  const alias = join(dir, "alias");
  symlinkSync(outsideChild, alias);
  const out = join(realpathSync(dir), "out");
  const counts = extractSessions(input, `${alias}/../out`);
  expect(counts).toEqual({ sessionsRead: 2, sessionsSkipped: 1, batches: 3, longResults: 1, spillPresent: 1, spillMissing: 1, protectedExclusions: 1 });
  const raw = readFileSync(join(out, "one.json"), "utf8");
  expect(raw).not.toContain("RAW-SPILL");
  expect(raw).not.toContain("private sidecar bytes");
  const session = JSON.parse(raw);
  expect(session.batches.map((b: any) => b.toolCalls[0].resultText.length)).toEqual([0, 0, 70000]);
  expect(session.batchPositions.map((b: any) => b.results[0])).toEqual([
    { position: 2, occurrenceKey: `same@${Date.UTC(2026, 0, 1) + 2000}`, spilled: true, sidecar: "present" },
    { position: 5, occurrenceKey: `same@${Date.UTC(2026, 0, 1) + 5000}`, spilled: true, sidecar: "missing" },
    { position: 7, occurrenceKey: `same@${Date.UTC(2026, 0, 1) + 7000}`, spilled: false },
  ]);
  expect(session.messages.map((m: any) => m.position)).toEqual([0, 1, 4, 6, 8]);
  expect(session.messages[1]).toMatchObject({ role: "assistant", text: "own text", toolArgs: [{ path: "source.ts" }, { path: "skills/test/info.md" }] });
  expect(session.counts.sessionsRead).toBe(1);
});

test("extract refuses checkout output before opening input or creating directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-refusal-"));
  const alias = join(dir, "alias");
  symlinkSync(join(process.cwd(), "eval"), alias);
  const destination = join(process.cwd(), "never-created-replay");
  expect(existsSync(destination)).toBe(false);
  expect(() => extractSessions("missing-input", `${alias}/../never-created-replay`)).toThrow("Replay destination must be outside all checkouts");
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(join(dir, "never-created-replay"))).toBe(false);
});
