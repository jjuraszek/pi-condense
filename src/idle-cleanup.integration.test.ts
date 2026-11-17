import { describe, expect, it, jest, spyOn } from "bun:test";
import * as summarizer from "./summarizer.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBatch, extractToolResultText, projectBranchMessages } from "./batch-capture.js";
import { ToolCallIndexer } from "./indexer.js";
import { detectChains } from "./chain-detector.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { supersededStub } from "./supersede.js";
import { DiagnosticSink } from "./diagnostics.js";
import { CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_DIAGNOSTIC, CUSTOM_TYPE_FLUSH_METRICS, CUSTOM_TYPE_SUMMARY, DEFAULT_CONFIG, QUERY_TOOL_NAME, SETTLED_FLUSH_DELAY_MS } from "./types.js";

function closedChainBranch(endMs: number, count: number): any[] {
  const branch: any[] = [];
  let timestamp = endMs - count * 4000;
  const appendMessage = (message: any) => {
    timestamp += 1000;
    branch.push({
      type: "message",
      id: `entry-${branch.length}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date(timestamp).toISOString(),
      message: { ...message, timestamp },
    });
  };
  for (let i = 0; i < count; i++) {
    appendMessage({ role: "user", content: [{ type: "text", text: `Run task ${i}.` }] });
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { command: `echo task-${i}` } }],
      stopReason: "toolUse",
    });
    appendMessage({
      role: "toolResult", toolCallId: `tc${i}`, toolName: "bash",
      content: [{ type: "text", text: `raw result for task ${i}` }], isError: false,
    });
    appendMessage({ role: "assistant", content: [{ type: "text", text: `Task ${i} finished.` }], stopReason: "stop" });
  }
  return branch;
}

async function boot(branch: any[], hasUI: boolean, config: Record<string, unknown> = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-idle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextPrune: { enabled: true, showPruneStatusLine: false, ...config } }));

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, any>();
  const appended: Array<{ type: string; data: any }> = [];
  const appendEntry = (type: string, data: any) => {
    const id = `entry-${branch.length}`;
    appended.push({ type, data });
    branch.push({ type: "custom", customType: type, data, id, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
    return id;
  };
  const pi: any = {
    on: (name: string, fn: (event: any, ctx: any) => any) => handlers.set(name, fn),
    appendEntry,
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() { throw new Error("The idle fixture must not send a summary message."); },
    events: { emit() {} },
  };
  const ctx: any = {
    hasUI,
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry: appendEntry,
      appendCustomMessageEntry: (customType: string, content: string, display: boolean, details: unknown) => {
        branch.push({ type: "custom_message", customType, content, display, details, timestamp: new Date().toISOString() });
      },
      getSessionDir: () => agentDir,
      getSessionId: () => "idle-test",
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 200000 }),
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => { throw new Error("The idle fixture must not request credentials."); },
      streamSimple: () => { throw new Error("The idle fixture must not call a model."); },
    },
    ui: { setStatus() {}, setWidget() {}, notify() {} },
  };
  const fire = (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const restore = () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  };
  try {
    const extension = (await import("../index.js")).default;
    extension(pi);
    await fire("session_start");
  } catch (error) {
    restore();
    throw error;
  }
  const request = async () => {
    const messages = [
      ...projectBranchMessages(branch),
      { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: Date.now() },
    ];
    return (await fire("context", { messages }))?.messages ?? messages;
  };
  const submit = async (source = "interactive", messageType = "user") => {
    await fire("input", { text: "Continue.", source });
    await fire("before_agent_start", { messageType, prompt: "Continue.", systemPrompt: "" });
  };
  const compact = () => commands.get("pruner").handler("compact", ctx);
  return { fire, appended, restore, request, submit, compact, ctx, pi };
}

function summarizedBranch(endMs: number) {
  const branch = closedChainBranch(endMs, 4);
  const summaries = ["  First batch.\nKeep this spacing.  ", "Second batch refers to {b1}.\n", "\nThird batch stays separate."];
  const indexer = new ToolCallIndexer();
  for (let i = 0; i < summaries.length; i++) {
    const call = branch[i * 4 + 1].message;
    const result = branch[i * 4 + 2].message;
    const batch = captureBatch(call, [result], i, result.timestamp);
    indexer.addBatch(batch, (customType, data) => branch.push({ type: "custom", customType, data }));
    branch.push({
      type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: summaries[i], display: false,
      details: { toolCallRefs: indexer.allocateSummaryRefs(batch) }, timestamp: new Date(endMs + i + 1).toISOString(),
    });
  }
  branch.splice(7, 2); // Two batches in the second chain make fusion observable.
  const protectedResults = [
    { tool: "read", args: { path: "/project/skills/review/SKILL.md" }, text: "1. Inspect.\n2. Ask: A) Apply or B) Stop?\n" },
    { tool: "plan_tracker", args: {}, text: "Task 1: complete\nTask 2: in_progress\n  Keep {b1} literal." },
    { tool: "phase_tracker", args: {}, text: "Phase: implementation\nNext: verification\n" },
    { tool: "read", args: { path: "/project/skills/review/diagram.md" }, text: "Diagram caption.  " },
  ].map(({ tool, args, text }, i) => {
    const id = `protected-${i}`;
    branch[5].message.content.push({ type: "toolCall", id, name: tool, arguments: args });
    const message = {
      role: "toolResult", toolCallId: id, toolName: tool, isError: false,
      timestamp: branch[6].message.timestamp + i + 1,
      content: [{ type: "text", text }] as any[],
    };
    if (i === 3) message.content.push({ type: "image", mimeType: "image/png", data: "c3ludGhldGlj" });
    return message;
  });
  branch.splice(7, 0, ...protectedResults.map((message) => ({ type: "message", timestamp: new Date(message.timestamp).toISOString(), message })));
  const messages = projectBranchMessages(branch);
  const users = messages.filter((m) => m.role === "user");
  const finals = messages.filter((m) => m.role === "assistant" && m.stopReason === "stop");
  for (const user of users) user.content.push({ type: "text", text: "\n  Preserve the user's exact words.\n" });
  for (const final of finals) final.content.unshift({ type: "thinking", thinking: "Private deliberation.", thinkingSignature: "signature" });
  return { branch, summaries, protectedResults, users, finals };
}

describe("idle cleanup", () => {
  it.each(["summarized", "error"] as const)("awaits a settled flush (%s) before idle cleanup and the first request", async (outcome) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 2);
    for (const entry of branch) {
      if (entry.message.role === "toolResult") entry.message.content[0].text = "raw result ".repeat(20);
    }
    const harness = await boot(branch, true, { minBatchChars: 0 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const summarize = spyOn(summarizer, "summarizeBatches").mockImplementation(async (batches) => {
      await held;
      return batches.map(() => outcome === "error" ? null : {
        summaryText: "Done.",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    });
    jest.useFakeTimers();
    try {
      await harness.fire("turn_end", { turnIndex: 1, message: branch[5].message, toolResults: [branch[6].message] });
      await harness.fire("agent_settled");
      jest.advanceTimersByTime(SETTLED_FLUSH_DELAY_MS);
      expect(summarize).toHaveBeenCalledTimes(1);
      let submitted = false;
      const prompt = harness.submit().then(() => { submitted = true; });
      await Promise.resolve();
      expect(submitted).toBe(false);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      release();
      await prompt;
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_FLUSH_METRICS)
        .map((entry) => [entry.data.trigger, entry.data.outcome])).toEqual([["settled", outcome]]);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)
        .map((entry) => entry.data.startUserTimestamp)).toEqual([branch[0].message.timestamp, branch[4].message.timestamp]);
      const request = await harness.request();
      const bodies = request.filter((m: any) => m.content?.[0]?.text?.startsWith("<compressed-chain"));
      expect(bodies).toHaveLength(2);
      expect(request.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
      for (const body of bodies) {
        expect(body.content[0].text).toContain(outcome === "error" ? "raw result ".repeat(20) : "Done.");
        if (outcome === "summarized") expect(body.content[0].text).not.toContain("raw result");
      }
      expectNoOrphanToolResults(request);
    } finally {
      release();
      await harness.fire("session_shutdown");
      jest.useRealTimers();
      summarize.mockRestore();
      harness.restore();
    }
  });

  it("skips idle cleanup for an unawaited budget flush still in flight at submission", async () => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 2);
    const harness = await boot(branch, false, { minBatchChars: 0, autoBudgetThreshold: 0.8 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const summarize = spyOn(summarizer, "summarizeBatches").mockImplementation(async (batches) => {
      entered();
      await held;
      return batches.map(() => null);
    });
    let flush: Promise<unknown> | undefined;
    try {
      harness.ctx.getContextUsage = () => ({ tokens: 190000, contextWindow: 200000 });
      flush = harness.fire("turn_end", { turnIndex: 1, message: branch[5].message, toolResults: [branch[6].message] });
      await started;
      expect(summarize).toHaveBeenCalledTimes(1);
      await harness.submit();
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      const request = await harness.request();
      expect(request.filter((m: any) => m.role === "toolResult")).toEqual([branch[2].message, branch[6].message]);
      expect(request.some((m: any) => m.content?.[0]?.text?.startsWith("<compressed-chain"))).toBe(false);
      expectNoOrphanToolResults(request);
    } finally {
      release();
      await flush;
      summarize.mockRestore();
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it("compresses re-armed no-UI chains without flushing before the first request", async () => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 2);
    const harness = await boot(branch, false, { minBatchChars: 0 });
    const summarize = spyOn(summarizer, "summarizeBatches");
    try {
      await harness.submit("rpc");
      expect(summarize).not.toHaveBeenCalled();
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_FLUSH_METRICS)).toHaveLength(0);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)
        .map((entry) => entry.data.startUserTimestamp)).toEqual([branch[0].message.timestamp, branch[4].message.timestamp]);
      const request = await harness.request();
      const bodies = request.filter((m: any) => m.content?.[0]?.text?.startsWith("<compressed-chain"));
      expect(bodies).toHaveLength(2);
      for (const i of [0, 1]) expect(bodies[i].content[0].text).toContain(`raw result for task ${i}`);
      expect(request.filter((m: any) => m.role === "toolResult")).toHaveLength(0);
      expectNoOrphanToolResults(request);
    } finally {
      summarize.mockRestore();
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { failure: "before the first append", successfulAppends: 0 },
    { failure: "after one append", successfulAppends: 1 },
  ])("continues the prompt on failure $failure, preserving partial cleanup across retries and reload", async ({ successfulAppends }) => {
    const endMs = Date.now() - 240 * 60_000;
    const branch = closedChainBranch(endMs, 4);
    const path = "/project/skills/review/SKILL.md";
    for (const i of [0, 12]) {
      const call = branch[i + 1].message.content[0];
      call.name = "read";
      call.arguments = { path };
      branch[i + 2].message.toolName = "read";
    }
    const newerRead = branch.splice(12);
    const harness = await boot(branch, false);
    const report = spyOn(DiagnosticSink.prototype, "report");
    const append = harness.pi.appendEntry;
    let failing = true;
    const appendSpy = spyOn(harness.pi, "appendEntry").mockImplementation((type: string, data: any) => {
      if (failing && type === CUSTOM_TYPE_CHAIN &&
          harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN).length === successfulAppends) {
        throw new Error("idle append failed");
      }
      return append(type, data);
    });
    let partialBranch: any[];
    let partialRequest: any[];
    try {
      await harness.request(); // Consume the cold floor before the covering read exists.
      branch.push(...newerRead);
      const before = await harness.request();
      expect(before.find((m: any) => m.timestamp === branch[2].message.timestamp)).toEqual(branch[2].message);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(harness.submit()).resolves.toBeUndefined();
        expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(successfulAppends);
      }
      expect(report).toHaveBeenCalledWith("idle-cleanup-failed", String(endMs), expect.stringContaining("idle append failed"));
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_DIAGNOSTIC)).toHaveLength(1);
      partialRequest = (await harness.request()).slice(0, -1);
      expect(partialRequest.filter((m: any) => m.role === "toolResult" && m.toolName === "bash")).toHaveLength(2 - successfulAppends);
      expect(partialRequest.find((m: any) => m.timestamp === branch[2].message.timestamp).content[0].text).toBe(supersededStub(path));
      expect(partialRequest.find((m: any) => m.timestamp === newerRead[2].message.timestamp)).toEqual(newerRead[2].message);
      expect(partialRequest.filter((m: any) => m.content?.[0]?.text?.startsWith("<compressed-chain"))).toHaveLength(successfulAppends);
      expectNoOrphanToolResults(partialRequest);
      partialBranch = structuredClone(branch);

      failing = false;
      await harness.submit();
      const compressed = harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN);
      expect(compressed).toHaveLength(2);
      expect(new Set(compressed.map((entry) => entry.data.startUserTimestamp)).size).toBe(2);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_DIAGNOSTIC)).toHaveLength(1);
      expect((await harness.request()).filter((m: any) => m.role === "toolResult" && m.toolName === "bash")).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
      report.mockRestore();
      await harness.fire("session_shutdown");
      harness.restore();
    }
    const reloaded = await boot(partialBranch!, false);
    try {
      expect((await reloaded.request()).slice(0, -1)).toEqual(partialRequest!);
      await reloaded.submit();
      expect(reloaded.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(2 - successfulAppends);
      expectNoOrphanToolResults(await reloaded.request());
    } finally {
      await reloaded.fire("session_shutdown");
      reloaded.restore();
    }
  });

  it.each([
    { minutes: 0.5, age: 0.25, hasUI: false, compressed: 0 },
    { minutes: 0.5, age: 1, hasUI: false, compressed: 3 },
    { minutes: 60, age: 59, hasUI: true, compressed: 0 },
    { minutes: 60, age: 61, hasUI: true, compressed: 3 },
    { minutes: 480, age: 240, hasUI: false, compressed: 0 },
    { minutes: 480, age: 481, hasUI: false, compressed: 3 },
  ])("honors a custom threshold loaded from partial settings (%j)", async ({ minutes, age, hasUI, compressed }) => {
    const branch = closedChainBranch(Date.now() - age * 60_000, 3);
    const harness = await boot(branch, hasUI, { chainCompression: { idleCleanupMinutes: minutes } });
    try {
      const messages = [
        ...projectBranchMessages(branch),
        { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: Date.now() },
      ];
      const before = (await harness.fire("context", { messages }))?.messages ?? messages;
      await harness.submit();
      const after = (await harness.fire("context", { messages }))?.messages ?? messages;
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(compressed);
      expect(after.filter((message: any) => message.role === "toolResult")).toHaveLength(3 - compressed);
      if (compressed === 0) expect(after).toEqual(before);
      expectNoOrphanToolResults(after);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { promptCache: undefined, age: 60, compressed: 0 },
    { promptCache: undefined, age: 240, compressed: 3 },
    { promptCache: { short: 300 }, age: 60, compressed: 0 },
    { promptCache: { short: 300 }, age: 240, compressed: 3 },
  ])("a model without a declared lifetime uses the threshold (%j)", async ({ promptCache, age, compressed }) => {
    const harness = await boot(closedChainBranch(Date.now() - age * 60_000, 3), false);
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CACHE_RETENTION = "long";
      harness.ctx.model = { id: "fixture", provider: "fixture", api: "anthropic-messages", promptCache };
      const before = (await harness.request()).slice(0, -1);
      await harness.submit();
      const after = (await harness.request()).slice(0, -1);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(compressed);
      expect(after.filter((message: any) => message.role === "toolResult")).toHaveLength(3 - compressed);
      if (compressed === 0) expect(after).toEqual(before);
      expectNoOrphanToolResults(after);
    } finally {
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { retention: "short", age: 4, compressed: 0 },
    { retention: "short", age: 6, compressed: 3 },
    { retention: "long", age: 30, compressed: 0 },
    { retention: "long", age: 61, compressed: 3 },
    { retention: "none", age: 4, compressed: 0 },
    { retention: "none", age: 6, compressed: 3 },
    { retention: undefined, age: 4, compressed: 0 },
    { retention: undefined, age: 6, compressed: 3 },
  ])("the handler passes the model's declared lifetime (%j)", async ({ retention, age, compressed }) => {
    const branch = closedChainBranch(Date.now() - age * 60_000, 3);
    const harness = await boot(branch, false, {
      chainCompression: { ...DEFAULT_CONFIG.chainCompression, idleCleanupMinutes: 1 },
    });
    const previousRetention = process.env.PI_CACHE_RETENTION;
    try {
      if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = retention;
      harness.ctx.model = { id: "fixture", provider: "fixture", api: "anthropic-messages", promptCache: { short: 300, long: 3600 } };
      const messages = [
        ...projectBranchMessages(branch),
        { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: Date.now() },
      ];
      const before = (await harness.fire("context", { messages }))?.messages ?? messages;
      await harness.submit();
      const after = (await harness.fire("context", { messages }))?.messages ?? messages;
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(compressed);
      expect(after.filter((message: any) => message.role === "toolResult")).toHaveLength(3 - compressed);
      if (compressed === 0) expect(after).toEqual(before);
      expectNoOrphanToolResults(after);
    } finally {
      if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousRetention;
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { hasUI: true, kind: "cache_warm", warmAge: 60, compressed: 0 },
    { hasUI: false, kind: "cache_warm", warmAge: 60, compressed: 0 },
    { hasUI: false, kind: "cache_warm", warmAge: 240, compressed: 3 },
    { hasUI: false, kind: "other", warmAge: 60, compressed: 3 },
  ])("a cache-warm entry restarts the clock (%j)", async ({ hasUI, kind, warmAge, compressed }) => {
    const now = Date.now();
    const branch = closedChainBranch(now - 300 * 60_000, 3);
    branch.push({
      type: "usage", id: "warm-entry", parentId: branch.at(-1).id,
      timestamp: new Date(now - warmAge * 60_000).toISOString(), kind, provider: "fixture", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0, totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const harness = await boot(branch, hasUI);
    try {
      const messages = [
        ...projectBranchMessages(branch),
        { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: now },
      ];
      const before = (await harness.fire("context", { messages }))?.messages ?? messages;
      await harness.submit();
      const after = (await harness.fire("context", { messages }))?.messages ?? messages;
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(compressed);
      expect(after.filter((message: any) => message.role === "toolResult")).toHaveLength(3 - compressed);
      if (compressed === 0) expect(after).toEqual(before);
      expectNoOrphanToolResults(after);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { idle: true, fuse: true },
    { idle: false, fuse: false },
    { idle: false, fuse: true },
  ])("keeps literal idle summaries and protected outputs across reload, while compact keeps its rendering (%j)", async ({ idle, fuse }) => {
    const fixture = summarizedBranch(Date.now() - 240 * 60_000);
    const config = {
      protectedTools: ["plan_tracker", "phase_tracker"], summarizerModel: "default",
      chainCompression: { ...DEFAULT_CONFIG.chainCompression, fuseRangeSummary: fuse },
    };
    const harness = await boot(fixture.branch, false, config);
    const fuseInputs: string[] = [];
    harness.ctx.model = { id: "fixture", provider: "fixture", api: "fixture" };
    harness.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "synthetic" });
    harness.ctx.modelRegistry.streamSimple = (_model: any, input: any) => {
      fuseInputs.push(input.messages[0].content[0].text);
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return {
            stopReason: "stop", content: [{ type: "text", text: "FUSED refers to {b1}." }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
        },
      };
    };
    let rendered: any[];
    try {
      await harness.request(); // Consume session_start's cold floor before the covering read exists.
      const older = fixture.protectedResults[0];
      const callEntry = fixture.branch.find((entry) => entry.message?.content?.some((block: any) => block.type === "toolCall" && block.id === older.toolCallId));
      const olderCall = callEntry.message.content.find((block: any) => block.type === "toolCall" && block.id === older.toolCallId);
      const newer = {
        ...older, toolCallId: "protected-newer", timestamp: older.timestamp + 1,
        content: [{ type: "text", text: "Updated skill instructions." }],
      };
      callEntry.message.content.push({ ...olderCall, id: newer.toolCallId });
      const olderIndex = fixture.branch.findIndex((entry) => entry.message === older);
      fixture.branch.splice(olderIndex + 1, 0, { type: "message", timestamp: new Date(newer.timestamp).toISOString(), message: newer });
      fixture.protectedResults.splice(1, 0, newer);
      const before = await harness.request();
      expect(before.find((m: any) => m.toolCallId === older.toolCallId)).toEqual(older);
      expect(before.find((m: any) => m.toolCallId === newer.toolCallId)).toEqual(newer);

      if (idle) await harness.submit();
      else await harness.compact();
      const entries = harness.appended.filter((e) => e.type === CUSTOM_TYPE_CHAIN).map((e) => e.data);
      expect(entries).toHaveLength(3);
      expect(fuseInputs).toHaveLength(!idle && fuse ? 1 : 0);
      if (!idle && fuse) expect(fuseInputs[0]).toContain(fixture.summaries.slice(1).join("\n\n"));
      rendered = (await harness.request()).slice(0, -1);
      const bodies = rendered.filter((m: any) => m.role === "user" && m.content[0]?.text?.startsWith("<compressed-chain"));
      expect(bodies).toHaveLength(3);
      const storedBody = !idle && fuse ? "FUSED refers to {b1}." : fixture.summaries.slice(1).join("\n\n");
      const expectedBody = idle ? storedBody : storedBody.replace("{b1}", fixture.summaries[0]);
      const protectedBody = fixture.protectedResults.map((m) => {
        const text = m === older ? supersededStub(olderCall.arguments.path) : extractToolResultText(m);
        return `\n\n<protected-output tool="${m.toolName}">\n${text}\n</protected-output>`;
      }).join("");
      expect(bodies[1].content[0].text).not.toContain(extractToolResultText(older));
      expect(bodies[1].content[0].text).toBe(`<compressed-chain id="${entries[1].blockId}" tools="${entries[1].toolRefs.join(",")}">\n${expectedBody}${protectedBody}\n</compressed-chain>`);
      expect(bodies[0].content[0].text).toContain(`\n${fixture.summaries[0]}\n</compressed-chain>`);
      for (const entry of entries) expect(entry.literalSummary).toBe(idle ? true : undefined);
      for (const user of fixture.users) expect(rendered.find((m) => m.timestamp === user.timestamp)).toEqual(user);
      for (const final of fixture.finals) expect(rendered.find((m) => m.timestamp === final.timestamp)).toEqual({
        ...final, content: final.content.filter((b: any) => b.type !== "thinking"),
      });
      expect(rendered.some((m) => m.customType === CUSTOM_TYPE_SUMMARY || m.role === "toolResult")).toBe(false);
      expectNoOrphanToolResults(rendered);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
    const reloaded = await boot(JSON.parse(JSON.stringify(fixture.branch)), false, config);
    try {
      expect((await reloaded.request()).slice(0, -1)).toEqual(rendered!);
      expect(reloaded.appended.filter((e) => e.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
    } finally {
      await reloaded.fire("session_shutdown");
      reloaded.restore();
    }
  });

  it.each([true, false])("retains unsummarized occurrences in idle chains across reload without changing manual compression (idle=%s)", async (idle) => {
    const endMs = Date.now() - 240 * 60_000;
    const branch = closedChainBranch(endMs, 2);
    const indexer = new ToolCallIndexer();
    const call = branch[1].message;
    const summarized = branch[2].message;
    const batch = captureBatch(call, [summarized], 0, summarized.timestamp);
    indexer.addBatch(batch, (customType, data) => branch.push({ type: "custom", customType, data }));
    const summary = "  Earlier work is complete. Keep {b99} literal.\n";
    branch.push({
      type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: summary, display: false,
      details: { toolCallRefs: indexer.allocateSummaryRefs(batch) }, timestamp: new Date(endMs + 1).toISOString(),
    });
    const latest = {
      role: "toolResult", toolCallId: summarized.toolCallId, toolName: "plan_tracker", isError: false,
      timestamp: summarized.timestamp + 2,
      content: [{ type: "text", text: "Task: install guards\nStatus: in_progress\n  Keep {b99} literal.\n" }],
    };
    branch[3].message.stopReason = "error";
    branch.splice(3, 0,
      { type: "message", message: { role: "assistant", timestamp: summarized.timestamp + 1, stopReason: "toolUse",
        content: [{ type: "toolCall", id: latest.toolCallId, name: latest.toolName, arguments: {} }] } },
      { type: "message", message: latest },
    );
    const zeroSummary = branch[8].message;
    zeroSummary.content.push({ type: "image", mimeType: "image/png", data: "c3ludGhldGlj" });
    const config = { protectedTools: [], chainCompression: { ...DEFAULT_CONFIG.chainCompression, fuseRangeSummary: false } };
    const harness = await boot(branch, false, config);
    let rendered: any[];
    try {
      if (idle) await harness.submit();
      else await harness.compact();
      const entries = harness.appended.filter((e) => e.type === CUSTOM_TYPE_CHAIN).map((e) => e.data);
      expect(entries).toHaveLength(2);
      expect(entries[0].bodySource).toBeUndefined();
      expect(entries[1].bodySource).toBe("deterministic");
      rendered = (await harness.request()).slice(0, -1);
      const bodies = rendered.filter((m) => m.role === "user" && m.content[0]?.text?.startsWith("<compressed-chain"));
      expect(bodies).toHaveLength(2);
      expect(bodies[0].content[0].text).toContain(summary);
      expect(bodies[0].content[0].text).not.toContain(extractToolResultText(summarized));
      for (const [i, result] of [latest, zeroSummary].entries()) {
        const text = extractToolResultText(result);
        const block = `\n\n<protected-output tool="${result.toolName}">\n${text}\n</protected-output>`;
        expect(bodies[i].content[0].text.includes(block)).toBe(idle);
        expect(entries[i].protectedToolCallIds ?? []).toEqual(idle ? [`${result.toolCallId}@${result.timestamp}`] : []);
      }
      const restoredIndex = new ToolCallIndexer();
      restoredIndex.reconstructFromSession(harness.ctx);
      expect(restoredIndex.getRecord(`${zeroSummary.toolCallId}@${zeroSummary.timestamp}`)?.resultText).toBe(extractToolResultText(zeroSummary));
      expectNoOrphanToolResults(rendered);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
    const reloaded = await boot(JSON.parse(JSON.stringify(branch)), false, config);
    try {
      expect((await reloaded.request()).slice(0, -1)).toEqual(rendered!);
      expect(reloaded.appended.filter((e) => e.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
    } finally {
      await reloaded.fire("session_shutdown");
      reloaded.restore();
    }
  });

  it.each([
    { mixed: false, newerLimit: undefined, replaced: true },
    { mixed: true, newerLimit: undefined, replaced: true },
    { mixed: false, newerLimit: 50, replaced: false },
  ])("stubs a waiting superseded protected read (%j)", async ({ mixed, newerLimit, replaced }) => {
    const path = "/project/skills/review/SKILL.md";
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 3);
    for (const i of [0, 8]) {
      const call = branch[i + 1].message.content[0];
      call.id = "read-again";
      call.name = "read";
      call.arguments = { path, limit: i === 0 ? 100 : newerLimit };
      branch[i + 2].message.toolCallId = call.id;
      branch[i + 2].message.toolName = "read";
    }
    const newer = branch.splice(8);
    if (mixed) branch.splice(3, 2); // One closed chain holds the read and ordinary tool work.
    else branch.splice(4);
    const original = branch[2].message.content[0].text;
    const harness = await boot(branch, false);
    try {
      await harness.request(); // Consume session_start's cold floor before the covering read exists.
      branch.push(...newer);
      const before = await harness.request();
      expect(before.find((m: any) => m.timestamp === branch[2].message.timestamp).content[0].text).toBe(original);
      await harness.submit();
      const request = await harness.request();
      const text = request.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text) : []).join("\n");
      expect(text.includes(supersededStub(path))).toBe(replaced);
      expect(text.includes(original)).toBe(!replaced);
      expect(request.find((m: any) => m.timestamp === newer[2].message.timestamp)).toEqual(newer[2].message);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(mixed ? 1 : 0);
      expectNoOrphanToolResults(request);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([undefined, "model_select", "session_compact", "thinking_level_select"])("keeps the turn in progress and any pending cold floor (%s)", async (coldEvent) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 4);
    for (const i of [0, 8, 12]) {
      const call = branch[i + 1].message.content[0];
      call.id = "read-again";
      call.name = "read";
      call.arguments = { path: "/project/skills/review/SKILL.md" };
      branch[i + 2].message.toolCallId = call.id;
      branch[i + 2].message.toolName = "read";
    }
    const open = branch.splice(8);
    open.pop();
    open.splice(3, 2);
    open[1].message.content.unshift({ type: "thinking", thinking: "Work still in progress.", thinkingSignature: "keep-signature" });
    branch.splice(3, 2);
    const indexer = new ToolCallIndexer();
    const result = branch[4].message;
    const batch = captureBatch(branch[3].message, [result], 0, result.timestamp);
    indexer.addBatch(batch, (customType, data) => branch.push({ type: "custom", customType, data }));
    const summary = "  Last closed chain is complete. Keep {b99} literal.\n";
    branch.push({
      type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, content: summary, display: false,
      details: { toolCallRefs: indexer.allocateSummaryRefs(batch) }, timestamp: new Date(branch[5].message.timestamp + 1).toISOString(),
    });
    const renders: any[][] = [];
    for (const source of ["extension", "interactive"]) {
      const copy = structuredClone(branch);
      const harness = await boot(copy, false);
      try {
        await harness.request();
        copy.push(...structuredClone(open));
        if (coldEvent) await harness.fire(coldEvent);
        await harness.submit(source);
        const prompt = { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: 1 };
        const messages = [...projectBranchMessages(copy), prompt];
        const request = (await harness.fire("context", { messages }))?.messages ?? messages;
        const openTimestamps = new Set([...open.map((entry) => entry.message.timestamp), prompt.timestamp]);
        // The trailing summary belongs to the closed chain, not the turn in progress.
        renders.push(request.filter((m: any) => openTimestamps.has(m.timestamp)));
        expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(source === "interactive" ? 1 : 0);
        const summaries = request.filter((m: any) => m.customType === CUSTOM_TYPE_SUMMARY);
        const bodies = request.filter((m: any) => m.role === "user" && m.content[0]?.text?.startsWith("<compressed-chain"));
        if (source === "interactive") {
          expect(summaries).toHaveLength(0);
          expect(bodies).toHaveLength(1);
          expect(bodies[0].content[0].text).toContain(summary);
        } else {
          expect(summaries).toHaveLength(1);
          expect(summaries[0].content).toBe(summary);
          expect(bodies).toHaveLength(0);
        }
        expectNoOrphanToolResults(request);
      } finally {
        await harness.fire("session_shutdown");
        harness.restore();
      }
    }
    expect(renders[1]).toEqual(renders[0]);
    expect(renders[1]).toHaveLength(open.length + 1);
    expect(renders[1][2].content[0].text).toBe(coldEvent
      ? supersededStub("/project/skills/review/SKILL.md")
      : open[2].message.content[0].text);
  });

  it.each([true, false])("does nothing below the threshold (hasUI=%s)", async (hasUI) => {
    const branch = closedChainBranch(Date.now() - 60 * 60_000, 3);
    const harness = await boot(branch, hasUI);
    try {
      const messages = [
        ...projectBranchMessages(branch),
        { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: Date.now() },
      ];
      const before = (await harness.fire("context", { messages }))?.messages ?? messages;
      await harness.submit();
      const after = (await harness.fire("context", { messages }))?.messages ?? messages;
      expect(after).toEqual(before);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each(["no-tool", "graced", "protected-only", "unresolvable"])("keeps %s chains while compressing eligible neighbors", async (exception) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 2);
    const firstChain = branch.slice(0, 4);
    if (exception === "no-tool") branch.splice(1, 2);
    if (exception === "graced" || exception === "protected-only") {
      const tool = exception === "graced" ? QUERY_TOOL_NAME : "read";
      firstChain[1].message.content[0].name = tool;
      firstChain[1].message.content[0].arguments = exception === "graced" ? { ref: "t1" } : { path: "/project/skills/review/SKILL.md" };
      firstChain[2].message.toolName = tool;
    }
    if (exception === "unresolvable") firstChain[1].message.timestamp = firstChain[3].message.timestamp;
    const harness = await boot(branch, false);
    try {
      const before = (await harness.request()).filter((message: any) => firstChain.some((entry) => entry.message.timestamp === message.timestamp));
      await harness.submit();
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN).map((entry) => entry.data.startUserTimestamp))
        .toEqual([branch.find((entry) => entry.message?.role === "user" && entry.message.content[0].text === "Run task 1.").message.timestamp]);
      const request = await harness.request();
      expect(request.filter((message: any) => firstChain.some((entry) => entry.message.timestamp === message.timestamp))).toEqual(before);
      expectNoOrphanToolResults(request);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { source: "extension", messageType: "user", config: {} },
    { source: "interactive", messageType: "custom", config: {} },
    { source: "interactive", messageType: "user", config: { enabled: false } },
    { source: "rpc", messageType: "user", config: { pruneOn: "on-demand" } },
    { source: "interactive", messageType: "user", config: { chainCompression: { ...DEFAULT_CONFIG.chainCompression, enabled: false } } },
    { source: "interactive", messageType: "user", config: {}, shutdown: true },
  ])("gates idle compression by human submission, automatic pruning, and a live session (%j)", async ({ source, messageType, config, shutdown }) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 3);
    const harness = await boot(branch, true, config);
    try {
      if (shutdown) await harness.fire("session_shutdown");
      await harness.submit(source, messageType);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      expect((await harness.request()).filter((message: any) => message.role === "toolResult")).toHaveLength(3);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });

  it.each([
    { hasUI: true, source: "interactive", stopReason: "stop" },
    { hasUI: false, source: "interactive", stopReason: "stop" },
    { hasUI: true, source: "rpc", stopReason: "error" },
    { hasUI: false, source: "rpc", stopReason: "aborted" },
  ])("compresses every closed tool-using chain past the threshold (%j)", async ({ hasUI, source, stopReason }) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 3);
    for (let i = 3; i < branch.length; i += 4) branch[i].message.stopReason = stopReason;
    const chains = detectChains(projectBranchMessages(branch));
    expect(chains).toHaveLength(3);
    const harness = await boot(branch, hasUI);
    try {
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      await harness.submit(source);

      const compressed = harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN);
      expect(compressed).toHaveLength(3);
      expect(compressed.map((entry) => entry.data.startUserTimestamp)).toEqual(chains.map((chain) => chain.startUserTimestamp));
      const request = await harness.request();
      const bodies = request.flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((block: any) => block.type === "text" && block.text.startsWith("<compressed-chain"))
        : []);
      expect(bodies).toHaveLength(3);
      expect(request.filter((message: any) => message.role === "toolResult")).toHaveLength(0);
      expectNoOrphanToolResults(request);
      await harness.submit(source);
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(3);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });
});
