import { describe, it, expect } from "bun:test";

let seenInput: any;
function captureStream(_model: any, input: any) {
  seenInput = input;
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "- summary" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    },
  };
}

const { isUsableSummary, summarizeBatch, summarizerThinkingOptions } = await import("./summarizer.js");
const { DEFAULT_CONFIG } = await import("./types.js");

describe("isUsableSummary", () => {
  it("accepts non-empty text that stopped normally", () => {
    expect(isUsableSummary("- did a thing", "stop")).toBe(true);
  });
  it("rejects empty text", () => {
    expect(isUsableSummary("", "stop")).toBe(false);
  });
  it("rejects whitespace-only text", () => {
    expect(isUsableSummary("   \n\t ", "stop")).toBe(false);
  });
  it("rejects truncated output even with text", () => {
    expect(isUsableSummary("- partial", "length")).toBe(false);
  });
});

describe("summarizerThinkingOptions", () => {
  it("omits reasoning for default and off", () => {
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "default" })).toEqual({});
    expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: "off" })).toEqual({});
  });
  it("forwards every other level as reasoning", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(summarizerThinkingOptions({ ...DEFAULT_CONFIG, summarizerThinking: level })).toEqual({ reasoning: level });
    }
  });
});

describe("summarizer prompt", () => {
  it("tells the model that an image marker is an image it cannot see", async () => {
    const model = { id: "m", provider: "p", name: "M" };
    const ctx = {
      model,
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
        streamSimple: captureStream,
      },
      ui: { notify() {} },
    } as any;
    const batch = {
      turnIndex: 0,
      timestamp: 0,
      assistantText: "",
      toolCalls: [{ toolCallId: "a", toolName: "read", args: {}, resultText: "[image returned: image/png sha256:3f9a2c1e]\nRead image file [image/png]", isError: false }],
    } as any;
    await summarizeBatch(batch, DEFAULT_CONFIG, ctx);
    expect(JSON.stringify(seenInput)).toContain("means the tool returned an image you cannot see");
  });

  it("tells the model that an elided middle is omitted, not empty", async () => {
    const model = { id: "m", provider: "p", name: "M" };
    const ctx = {
      model,
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
        streamSimple: captureStream,
      },
      ui: { notify() {} },
    } as any;
    const batch = {
      turnIndex: 0,
      timestamp: 0,
      assistantText: "",
      toolCalls: [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "x".repeat(9000), isError: false }],
    } as any;
    await summarizeBatch(batch, DEFAULT_CONFIG, ctx);
    const sent = JSON.stringify(seenInput);
    expect(sent).toContain("chars elided");
    expect(sent).toContain("never report the elided region as empty or absent");
  });
});
