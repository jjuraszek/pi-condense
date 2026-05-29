import { describe, expect, it } from "bun:test";
import { purgeErroredArgs } from "./error-purge.js";
import type { ErrorPurgeConfig } from "./types.js";

const defaultConfig: ErrorPurgeConfig = {
  enabled: true,
  cooldownTurns: 2,
  minArgChars: 10,
};

function makeAssistant(toolCallId: string, argsObj: Record<string, any>, turnN?: number) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "bash",
        arguments: argsObj,
      },
    ],
    timestamp: turnN ?? 1,
  };
}

function makeToolResult(toolCallId: string, isError: boolean) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: isError ? "Error: file not found" : "ok" }],
    isError,
    timestamp: 2,
  };
}

describe("purgeErroredArgs", () => {
  it("returns input array reference unchanged when no errored tool results", () => {
    const messages = [
      makeAssistant("tc1", { cmd: "ls" }),
      makeToolResult("tc1", false),
    ];
    const result = purgeErroredArgs(messages, defaultConfig);
    expect(result).toBe(messages);
  });

  it("does not purge while still within cooldown", () => {
    // Error at turn 1, current = turn 2, age = 1 < cooldownTurns 2
    const messages = [
      makeAssistant("tc1", { content: "a very long argument body here" }),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2 });
    expect(result).toBe(messages);
    const asstMsg = result[0] as any;
    expect(asstMsg.content[0].arguments).toEqual({ content: "a very long argument body here" });
  });

  it("purges args after cooldown when args meet minArgChars", () => {
    const largeArgs = { content: "a very long argument body here" };
    const messages = [
      makeAssistant("tc1", largeArgs),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 10 });
    expect(result).not.toBe(messages);
    const purgedAsst = result[0] as any;
    const originalArgLen = JSON.stringify(largeArgs).length;
    expect(purgedAsst.content[0].arguments).toEqual({
      _purged: `<purged-errored-args size="${originalArgLen}"/>`,
    });
    // toolResult stays unchanged
    expect((result[1] as any).content[0].text).toBe("Error: file not found");
  });

  it("does not purge when args are below minArgChars", () => {
    const messages = [
      makeAssistant("tc1", { x: "hi" }), // JSON is only ~10 chars
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 1000 });
    expect(result).toBe(messages);
  });

  it("does not purge when isError is false", () => {
    const messages = [
      makeAssistant("tc1", { content: "a very long argument body here" }),
      makeToolResult("tc1", false), // NOT an error
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, defaultConfig);
    expect(result).toBe(messages);
  });

  it("only purges errored toolCalls in a multi-toolCall assistant message", () => {
    const largeArgs = { content: "a very long argument body here that is big" };
    const okArgs = { cmd: "ls" };
    const messages = [
      // One assistant with two toolCalls: tc-err is errored, tc-ok is not
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-err", name: "write", arguments: largeArgs },
          { type: "toolCall", id: "tc-ok", name: "bash", arguments: okArgs },
        ],
        timestamp: 1,
      },
      makeToolResult("tc-err", true),
      makeToolResult("tc-ok", false),
      makeAssistant("tc2", { cmd: "pwd" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "date" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 5 });
    expect(result).not.toBe(messages);
    const asst = result[0] as any;
    // errored one is purged
    const originalArgLen = JSON.stringify(largeArgs).length;
    expect(asst.content[0].arguments).toEqual({
      _purged: `<purged-errored-args size="${originalArgLen}"/>`,
    });
    // non-errored one is untouched
    expect(asst.content[1].arguments).toEqual(okArgs);
  });

  it("does not mutate the input messages array or any message object", () => {
    const largeArgs = { content: "a very long argument body here" };
    const messages = [
      makeAssistant("tc1", largeArgs),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const originalAsst = messages[0];
    const originalArgs = (messages[0] as any).content[0].arguments;
    purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 10 });
    // Input array unchanged
    expect(messages[0]).toBe(originalAsst);
    expect((messages[0] as any).content[0].arguments).toBe(originalArgs);
  });

  it("exactly-at-cooldown boundary: age === cooldownTurns is purged", () => {
    // Error at turn 1, 2 more assistant turns → age = 2 = cooldownTurns (should purge)
    const largeArgs = { content: "argument body that is long enough to purge" };
    const messages = [
      makeAssistant("tc1", largeArgs),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 5 });
    expect(result).not.toBe(messages);
    expect((result[0] as any).content[0].arguments._purged).toBeDefined();
  });

  it("one-below-cooldown boundary: age === cooldownTurns - 1 is NOT purged", () => {
    // Error at turn 1, 1 more assistant turn → age = 1 < cooldownTurns 2
    const largeArgs = { content: "argument body that is long enough to purge" };
    const messages = [
      makeAssistant("tc1", largeArgs),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 5 });
    expect(result).toBe(messages);
  });
});
