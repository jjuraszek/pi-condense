import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedEntries, type SeedTurn } from "../scenario";
import { captureBatch, extractToolResultText } from "../../src/batch-capture";
import { ToolCallIndexer } from "../../src/indexer";
import { occKey } from "../../src/occurrence-key";
import { DEFAULT_CONFIG, CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_SUMMARY } from "../../src/types";
import { pruneMessages } from "../../src/pruner";
import { parseIdleArgs, replayIdleSessions } from "./idle";
import { replayMain } from "./run";

function corpus() {
  const root = mkdtempSync(join(tmpdir(), "replay-idle-"));
  const input = join(root, "sessions"), agent = join(root, "agent"), out = join(root, "out");
  mkdirSync(input); mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ contextPrune: { enabled: true, protectedTools: ["plan_tracker"] } }));
  const entries: any[] = seedEntries([
    { role: "user", text: "Start synthetic work." },
    { role: "assistant", toolCalls: [{ id: "work", name: "bash", arguments: { command: "echo ok" } }] },
    { role: "result", toolCallId: "work", toolName: "bash", text: "  Keep unsummarized bytes.\n" },
    { role: "assistant", text: "First final answer." },
    { role: "user", text: "First return." },
    { role: "assistant", text: "Second final answer." },
    { role: "user", text: "Second return." },
    { role: "assistant", text: "Recent activity." },
  ], Date.UTC(2026, 0, 1));
  const base = Date.UTC(2026, 0, 1);
  entries.slice(1).forEach((entry, i) => {
    const time = base + (i < 4 ? i * 1000 : i < 6 ? 4 * 3600000 + i * 1000 : 8 * 3600000 + i * 1000);
    entry.timestamp = new Date(time).toISOString(); entry.message.timestamp = time;
  });
  writeFileSync(join(input, "synthetic.jsonl"), entries.map(e => JSON.stringify(e)).join("\n"));
  return { root, input, agent, out, entries };
}

test("idle dispatch finds both historical returns despite later activity, without a model runtime", async () => {
  const fixture = corpus(), printed: string[] = [];
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agent;
  try {
    const code = await replayMain(["idle", fixture.input, "--out", fixture.out], {
      runtime: async () => { throw Error("No runtime may be opened"); }, print: text => printed.push(text),
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(fixture.out, "idle.json"), "utf8"));
    expect(report).toMatchObject({ sessionsRead: 1, returnsFound: 2, returnsChecked: 2, violations: 0 });
    expect(Number.isFinite(report.estimatedTokensRemoved)).toBe(true);
    expect(Number.isFinite(report.medianPromptShareRemoved)).toBe(true);
    expect(printed.join("\n")).not.toContain("synthetic");
    expect(JSON.stringify(report)).not.toContain("Keep unsummarized");
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  }
});

function preservationCorpus() {
  const fixture = corpus();
  const branch = fixture.entries;
  const assistant = branch[2].message, result = branch[3].message;
  assistant.content.push(
    { type: "toolCall", id: "tracker", name: "plan_tracker", arguments: {} },
    { type: "toolCall", id: "never", name: "bash", arguments: {} },
  );
  const image = { ...result, toolCallId: "tracker", toolName: "plan_tracker", timestamp: result.timestamp + 1,
    content: [{ type: "text", text: "Protected tracker bytes.\n" }, { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" }] };
  const never = { ...result, toolCallId: "never", timestamp: result.timestamp + 2, content: [{ type: "text", text: "  Never summarized bytes.\n" }] };
  branch.splice(4, 0, ...[image, never].map(message => ({ type: "message", timestamp: new Date(message.timestamp).toISOString(), message })));
  branch[8].message = { ...branch[8].message, stopReason: "aborted", content: [{ type: "toolCall", id: "open", name: "bash", arguments: { command: "OPEN_ARGUMENT_BYTES" } }] };
  const indexer = new ToolCallIndexer();
  const extras: any[] = [];
  const batch = captureBatch({ ...assistant, content: [assistant.content[0]] }, [result], 0, result.timestamp);
  indexer.addBatch(batch, (customType, data) => extras.push({ type: "custom", customType, data }));
  const summary = "  Batch summary keeps {b99} literal.\n";
  // The summary belongs to the first chain even though an open turn precedes it.
  extras.push({ type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: summary, display: false,
    details: { toolCallRefs: indexer.allocateSummaryRefs(batch) } });
  branch.splice(9, 0, ...extras);
  branch.slice(1).forEach((entry, i) => { entry.id = `rich-${i}`; entry.parentId = i ? `rich-${i - 1}` : null; entry.timestamp ??= branch[8].timestamp; });
  writeFileSync(join(fixture.input, "synthetic.jsonl"), branch.map(entry => JSON.stringify(entry)).join("\n"));
  return { ...fixture, summary, marker: extractToolResultText(image), never: extractToolResultText(never) };
}

const protectedConfig = { ...DEFAULT_CONFIG, enabled: true, protectedTools: ["plan_tracker"] };

test("idle keeps partly summarized chains, owned summaries, protected image marker text and open messages", async () => {
  const fixture = preservationCorpus();
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out }, protectedConfig);
  expect(report).toMatchObject({ returnsFound: 2, returnsChecked: 2, violations: 0 });
  expect(report.protectedOutputComparison).toContain("image marker text");
  expect(report.violationRecords).toEqual([]);
});

// Renders like production, then loses `target` from every cleaned (second) render.
function losing(target?: string, cleaned: any[][] = []): typeof pruneMessages {
  let renders = 0;
  return (...args) => {
    const result = pruneMessages(...args);
    if (++renders % 2 !== 0) return result;
    if (target !== undefined) result.messages = result.messages.map(message => {
      const copy = structuredClone(message);
      if (typeof copy.content === "string") copy.content = copy.content.replaceAll(target, "LOST");
      else for (const block of copy.content ?? []) {
        if (block.type === "text") block.text = block.text.replaceAll(target, "LOST");
        if (block.type === "toolCall" && block.arguments?.command === target) block.arguments.command = "LOST";
      }
      return copy;
    });
    cleaned.push(result.messages);
    return result;
  };
}

test.each(["user", "final", "summary", "never summarized", "protected image", "open message"])("idle fails a seeded %s preservation violation without leaking content", async kind => {
  const fixture = preservationCorpus();
  const target = { user: "Start synthetic work.", final: "First final answer.", summary: fixture.summary,
    "never summarized": fixture.never, "protected image": fixture.marker, "open message": "OPEN_ARGUMENT_BYTES" }[kind]!;
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out }, protectedConfig, losing(target));
  expect(report.violations).toBeGreaterThan(0);
  expect(report.violationRecords.length).toBeGreaterThan(0);
  expect(Object.keys(report.violationRecords[0]).sort()).toEqual(["entryIndex", "sessionStem"]);
  expect(JSON.stringify(report)).not.toContain(target);
});

test.each(["read", "plan_tracker"])("idle permits a superseded protected %s and keeps the open turn's latest output", async tool => {
  const fixture = corpus();
  const entries = seedEntries([
    { role: "user", text: "Read the state." },
    { role: "assistant", toolCalls: [{ id: "old", name: tool, arguments: { path: "state.md" } }] },
    { role: "result", toolCallId: "old", toolName: tool, text: "Old protected state." },
    { role: "assistant", text: "Read complete." },
    { role: "user", text: "Check the state again." },
    { role: "assistant", toolCalls: [{ id: "new", name: "read", arguments: { path: "state.md" } }] },
    { role: "result", toolCallId: "new", toolName: "read", text: "Latest protected state." },
    { role: "user", text: "Return after a pause." },
  ], Date.UTC(2026, 0, 1));
  const last = entries.at(-1)!;
  last.timestamp = new Date(Date.UTC(2026, 0, 2)).toISOString();
  writeFileSync(join(fixture.input, "synthetic.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n"));
  let cleaned: any[] = [], renders = 0;
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out }, {
    ...protectedConfig, protectedPaths: ["state.md"],
  }, (...args) => {
    const result = pruneMessages(...args);
    if (++renders % 2 === 0) cleaned = result.messages;
    return result;
  });
  expect(report).toMatchObject({ returnsFound: 1, returnsChecked: 1, violations: 0 });
  expect(cleaned.find(message => message.toolCallId === "old").content[0].text).toStartWith("[Superseded: state.md");
  expect(cleaned.find(message => message.toolCallId === "new").content[0].text).toBe("Latest protected state.");
});

// One closed history, then a single return a day later; `extras` adds pruner entries before it.
function pausedSession(history: SeedTurn[], extras: (entries: any[]) => any[]) {
  const fixture = corpus();
  const entries: any[] = seedEntries([...history, { role: "user", text: "Return after a pause." }], Date.UTC(2026, 0, 1));
  const last = entries.pop();
  last.timestamp = new Date(Date.UTC(2026, 0, 2)).toISOString();
  entries.push(...extras(entries), last);
  entries.slice(1).forEach((entry, i) => { entry.id = `paused-${i}`; entry.parentId = i ? `paused-${i - 1}` : null; entry.timestamp ??= entries[1].timestamp; });
  writeFileSync(join(fixture.input, "synthetic.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n"));
  return fixture;
}

test("idle drops a deduplicated result's stub with its chain instead of restoring the raw output", async () => {
  const fixture = pausedSession([
    { role: "user", text: "Run it." },
    { role: "assistant", toolCalls: [{ id: "first", name: "bash", arguments: { command: "echo same" } }] },
    { role: "result", toolCallId: "first", toolName: "bash", text: "Same output." },
    { role: "assistant", text: "Ran it." },
    { role: "user", text: "Run it again." },
    { role: "assistant", toolCalls: [{ id: "again", name: "bash", arguments: { command: "echo same" } }] },
    { role: "result", toolCallId: "again", toolName: "bash", text: "Same output." },
    { role: "assistant", text: "Ran it again." },
  ], entries => {
    const indexer = new ToolCallIndexer(), extras: any[] = [];
    const append = (customType: string, data?: unknown) => { extras.push({ type: "custom", customType, data }); };
    const [call, first, again] = [entries[2].message, entries[3].message, entries[7].message];
    const batch = captureBatch(call, [first], 0, first.timestamp);
    indexer.addBatch(batch, append);
    extras.push({ type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: "The first run printed one line.", display: false,
      details: { toolCallRefs: indexer.allocateSummaryRefs(batch) } });
    indexer.registerDuplicate(occKey("again", again.timestamp), occKey("first", first.timestamp), append);
    return extras;
  });
  const cleaned: any[][] = [];
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out }, protectedConfig, losing(undefined, cleaned));
  expect(report).toMatchObject({ returnsFound: 1, returnsChecked: 1, violations: 0 });
  expect(JSON.stringify(cleaned)).toContain("<compressed-chain");
  expect(JSON.stringify(cleaned)).not.toContain("Same output.");
});

test.each([
  ["accepts", "read", undefined, false],
  ["accepts", "plan_tracker", undefined, false],
  ["rejects a lost chain body beside", "read", "Earlier chain body.", true],
  ["rejects a lost protected non-candidate output beside", "plan_tracker", "Tracker state.", true],
])("idle %s a superseded protected %s placeholder inside a chain compressed before the pause", async (_name, tool, lost, violates) => {
  const fixture = pausedSession([
    { role: "user", text: "Read the state." },
    { role: "assistant", toolCalls: [{ id: "old", name: tool, arguments: { path: "state.md" } }, { id: "tracker", name: "plan_tracker", arguments: {} }] },
    { role: "result", toolCallId: "old", toolName: tool, text: "Old protected state." },
    { role: "result", toolCallId: "tracker", toolName: "plan_tracker", text: "Tracker state." },
    { role: "assistant", text: "Read complete." },
    { role: "user", text: "Check the state again." },
    { role: "assistant", toolCalls: [{ id: "new", name: "read", arguments: { path: "state.md" } }] },
    { role: "result", toolCallId: "new", toolName: "read", text: "Latest protected state." },
    { role: "assistant", text: "Checked." },
  ], entries => [{ type: "custom", customType: CUSTOM_TYPE_CHAIN, data: {
    blockId: "b1", startUserTimestamp: entries[1].message.timestamp, finalAssistantTimestamp: entries[5].message.timestamp,
    droppedToolCallIds: ["old", "tracker"], protectedToolCallIds: ["old", "tracker"], toolRefs: [], compressedAt: 1,
    rangeSummaryText: "Earlier chain body.",
  } }]);
  const cleaned: any[][] = [];
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out }, {
    ...protectedConfig, protectedPaths: ["state.md"],
  }, losing(lost, cleaned));
  expect(report.returnsChecked).toBe(1);
  expect(report.violations > 0).toBe(violates);
  expect(cleaned[0][1].content[0].text).toContain(`<protected-output tool="${tool}">\n[Superseded: state.md`);
});

test("idle minutes override and argument validation", async () => {
  const fixture = corpus();
  expect(parseIdleArgs(["a", "b", "--minutes", "90", "--out", fixture.out])).toEqual({ inputs: ["a", "b"], minutes: 90, out: fixture.out });
  for (const args of [[], ["a", "--minutes", "0"], ["a", "--minutes", "NaN"], ["a", "--out"], ["a", "--other"], ["a", "--out", "x", "--out", "y"]]) expect(() => parseIdleArgs(args)).toThrow();
  const report = await replayIdleSessions({ inputs: [fixture.input], out: fixture.out, minutes: 300 }, protectedConfig);
  expect(report.returnsFound).toBe(0);
});

test("idle refuses checkout output before opening input or creating directories", async () => {
  const out = join(process.cwd(), "never-created-idle-replay");
  await expect(replayMain(["idle", "missing-input", "--out", out])).rejects.toThrow("Replay destination must be outside all checkouts");
  expect(existsSync(out)).toBe(false);
});
