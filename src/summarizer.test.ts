import { describe, it, expect, mock } from "bun:test";
import * as actualCompat from "@earendil-works/pi-ai/compat";

let seenInput: any;
mock.module("@earendil-works/pi-ai/compat", () => ({
  ...actualCompat,
  stream: (_model: any, input: any) => {
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
  },
}));

const { isUsableSummary, summarizeBatch } = await import("./summarizer.js");
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

describe("summarizer prompt", () => {
  it("tells the model that an image marker is an image it cannot see", async () => {
    const model = { id: "m", provider: "p", name: "M" };
    const ctx = {
      model,
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
        getProviderAuth: async () => undefined,
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
});
