import { describe, expect, it } from "bun:test";
import { getGrammarToolInput } from "@earendil-works/pi-ai/api/constrained-sampling";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model, Tool } from "@earendil-works/pi-ai";
import { purgeErroredArgs } from "./error-purge.js";

// Chat Completions and Responses share getGrammarToolInput; one transport covers the throw.
const model: Model<"openai-completions"> = {
  id: "grammar-test",
  name: "grammar-test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
  compat: { supportsOpenAIGrammarTools: true },
};

const codemode: Tool = {
  name: "codemode",
  description: "run code",
  parameters: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  } as any,
  constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: /[\\s\\S]*/' } },
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const meta = { api: "openai-completions", provider: "openai", model: "grammar-test", usage };

function history(codeArgs: Record<string, unknown>) {
  return [
    { role: "user", content: "run it", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "codemode", arguments: codeArgs }], ...meta, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "tc1", toolName: "codemode", content: [{ type: "text", text: "Error: boom" }], isError: true, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "retrying" }], ...meta, stopReason: "stop", timestamp: 4 },
    { role: "user", content: "again", timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "ok" }], ...meta, stopReason: "stop", timestamp: 6 },
    { role: "user", content: "go", timestamp: 7 },
  ] as any[];
}

async function request(messages: any[]) {
  let calls = 0;
  const fetchStub = (async () => {
    calls++;
    throw new Error("connection refused by stub");
  }) as unknown as typeof fetch;
  const result = await stream(model, { messages, tools: [codemode] }, { apiKey: "test", fetch: fetchStub, maxRetries: 0 }).result();
  return { result, calls };
}

describe("error purge x pi-ai grammar tools (#19)", () => {
  const config = { enabled: true, cooldownTurns: 2, minArgChars: 500 };

  it("purged codemode args pass getGrammarToolInput (reporter repro)", () => {
    const purged = purgeErroredArgs(history({ code: "x".repeat(1000) }), config);
    const args = purged[1].content[0].arguments;
    expect(typeof args.code).toBe("string");
    expect(Object.keys(args)).toEqual(["code"]);
    expect(JSON.stringify(args).length).toBeLessThan(500);
    expect(() => getGrammarToolInput("codemode", args, "code")).not.toThrow();
  });

  it("request building succeeds on purged history; failure is the connection, not the grammar", async () => {
    const purged = purgeErroredArgs(history({ code: "x".repeat(1000) }), config);
    expect(purged[1].content[0].arguments.code).toMatch(/^<purged-errored-args size=/);
    const { result, calls } = await request(purged);
    expect(result.stopReason).toBe("error");
    // The OpenAI SDK wraps fetch rejections in APIConnectionError and drops the cause message.
    expect(result.errorMessage).toMatch(/Connection error/);
    expect(result.errorMessage).not.toMatch(/Grammar tool call/);
    expect(calls).toBe(1);
  });

  it("negative control: the old { _purged } shape throws the grammar error before any request", async () => {
    const legacy = history({ code: "x".repeat(1000) });
    legacy[1].content[0].arguments = { _purged: '<purged-errored-args size="1012"/>' };
    const { result, calls } = await request(legacy);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/Grammar tool call "codemode" requires argument "code" to be a string/);
    expect(calls).toBe(0);
  });
});
