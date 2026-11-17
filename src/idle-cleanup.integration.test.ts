import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBranchMessages } from "./batch-capture.js";
import { detectChains } from "./chain-detector.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { supersededStub } from "./supersede.js";
import { CUSTOM_TYPE_CHAIN, DEFAULT_CONFIG, QUERY_TOOL_NAME } from "./types.js";

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
    registerCommand() {},
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
  return { fire, appended, restore, request, submit };
}

describe("idle cleanup", () => {
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
        renders.push(request.filter((m: any) => openTimestamps.has(m.timestamp)));
        expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(source === "interactive" ? 1 : 0);
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
  ])("gates idle compression by human submission and automatic pruning (%j)", async ({ source, messageType, config }) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 3);
    const harness = await boot(branch, true, config);
    try {
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
