import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBranchMessages } from "./batch-capture.js";
import { detectChains } from "./chain-detector.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { CUSTOM_TYPE_CHAIN } from "./types.js";

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

async function boot(branch: any[], hasUI: boolean) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-idle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextPrune: { enabled: true, showPruneStatusLine: false } }));

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
  return { fire, appended, restore };
}

describe("idle cleanup", () => {
  it.each([true, false])("compresses every closed tool-using chain past the threshold (hasUI=%s)", async (hasUI) => {
    const branch = closedChainBranch(Date.now() - 240 * 60_000, 3);
    const chains = detectChains(projectBranchMessages(branch));
    expect(chains).toHaveLength(3);
    const harness = await boot(branch, hasUI);
    try {
      expect(harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      await harness.fire("input", { text: "Continue.", source: "interactive" });
      await harness.fire("before_agent_start", { messageType: "user", prompt: "Continue.", systemPrompt: "" });

      const compressed = harness.appended.filter((entry) => entry.type === CUSTOM_TYPE_CHAIN);
      expect(compressed).toHaveLength(3);
      expect(compressed.map((entry) => entry.data.startUserTimestamp)).toEqual(chains.map((chain) => chain.startUserTimestamp));
      const messages = [
        ...projectBranchMessages(branch),
        { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: Date.now() },
      ];
      const request = (await harness.fire("context", { messages }))?.messages ?? messages;
      const bodies = request.flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((block: any) => block.type === "text" && block.text.startsWith("<compressed-chain"))
        : []);
      expect(bodies).toHaveLength(3);
      expect(request.filter((message: any) => message.role === "toolResult")).toHaveLength(0);
      expectNoOrphanToolResults(request);
    } finally {
      await harness.fire("session_shutdown");
      harness.restore();
    }
  });
});
