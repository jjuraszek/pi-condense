import { describe, expect, it } from "bun:test";
import { purgeErroredArgs } from "./error-purge.js";
import type { ErrorPurgeConfig } from "./types.js";

const defaultConfig: ErrorPurgeConfig = {
  enabled: true,
  cooldownTurns: 2,
  minArgChars: 10,
};

const LONG = "x".repeat(300);
const PLACEHOLDER_RE = /^<purged-errored-args size="\d+"\/>$/;

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
      makeAssistant("tc1", { content: LONG }),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2 });
    expect(result).toBe(messages);
    const asstMsg = result[0] as any;
    expect(asstMsg.content[0].arguments).toEqual({ content: LONG });
  });

  it("purges args after cooldown when args meet minArgChars", () => {
    const largeArgs = { content: LONG };
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
    expect(purgedAsst.content[0].arguments).toEqual({
      content: `<purged-errored-args size="${LONG.length}"/>`,
    });
    // toolResult stays unchanged
    expect((result[1] as any).content[0].text).toBe("Error: file not found");
  });

  it("does not purge when args are below minArgChars", () => {
    const messages = [
      makeAssistant("tc1", { x: LONG }),
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
      makeAssistant("tc1", { content: LONG }),
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
    const largeArgs = { content: LONG };
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
    expect(asst.content[0].arguments).toEqual({
      content: `<purged-errored-args size="${LONG.length}"/>`,
    });
    // non-errored one is untouched
    expect(asst.content[1].arguments).toEqual(okArgs);
  });

  it("does not mutate the input messages array or any message object", () => {
    const largeArgs = { content: LONG };
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
    // Error at turn 1, 2 more assistant turns -> age = 2 = cooldownTurns (should purge)
    const largeArgs = { content: LONG };
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
    expect((result[0] as any).content[0].arguments.content).toMatch(PLACEHOLDER_RE);
  });

  it("one-below-cooldown boundary: age === cooldownTurns - 1 is NOT purged", () => {
    // Error at turn 1, 1 more assistant turn -> age = 1 < cooldownTurns 2
    const largeArgs = { content: LONG };
    const messages = [
      makeAssistant("tc1", largeArgs),
      makeToolResult("tc1", true),
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars: 5 });
    expect(result).toBe(messages);
  });

  function purgedAfterCooldown(args: Record<string, any>, name: string, minArgChars: number) {
    const messages = [
      { ...makeAssistant("tc1", args), content: [{ type: "toolCall", id: "tc1", name, arguments: args }] },
      { ...makeToolResult("tc1", true), toolName: name },
      makeAssistant("tc2", { cmd: "ls" }),
      makeToolResult("tc2", false),
      makeAssistant("tc3", { cmd: "pwd" }),
      makeToolResult("tc3", false),
    ];
    const result = purgeErroredArgs(messages, { ...defaultConfig, cooldownTurns: 2, minArgChars });
    return { messages, result, args: (result[0] as any).content[0].arguments };
  }

  it("keeps a grammar tool's input property a string (codemode, #19)", () => {
    const { messages, result, args } = purgedAfterCooldown({ code: "x".repeat(1000) }, "codemode", 500);
    expect(result).not.toBe(messages);
    expect(typeof args.code).toBe("string");
    expect(Object.keys(args)).toEqual(["code"]);
    expect(args.code).toBe('<purged-errored-args size="1000"/>');
    expect(JSON.stringify(args).length).toBeLessThan(500);
  });

  it("write-shaped call keeps path verbatim and shrinks content", () => {
    const { args } = purgedAfterCooldown({ path: "src/foo.ts", content: "x".repeat(30000) }, "write", 500);
    expect(args.path).toBe("src/foo.ts");
    expect(args.content).toBe('<purged-errored-args size="30000"/>');
    expect(JSON.stringify(args).length).toBeLessThan(100);
  });

  it("edit-shaped call keeps the edits array length and shrinks only long values", () => {
    const original = {
      path: "src/foo.ts",
      edits: [
        { oldText: "a".repeat(15000), newText: "x" },
        { oldText: "y", newText: "b".repeat(15000) },
      ],
    };
    const { args } = purgedAfterCooldown(original, "edit", 500);
    expect(args.path).toBe("src/foo.ts");
    expect(Array.isArray(args.edits)).toBe(true);
    expect(args.edits).toHaveLength(2);
    expect(args.edits[0]).toEqual({ oldText: '<purged-errored-args size="15000"/>', newText: "x" });
    expect(args.edits[1]).toEqual({ oldText: "y", newText: '<purged-errored-args size="15000"/>' });
    expect(JSON.stringify(args).length).toBeLessThan(500);
  });

  it("non-string scalars and short strings pass through by type", () => {
    const { args } = purgedAfterCooldown({ line: 42, force: true, z: null, s: "short", big: "x".repeat(201) }, "bash", 10);
    expect(args.line).toBe(42);
    expect(args.force).toBe(true);
    expect(args.z).toBeNull();
    expect(args.s).toBe("short");
    expect(args.big).toBe('<purged-errored-args size="201"/>');
  });

  it("a string of exactly 200 chars stays verbatim", () => {
    const { messages, result } = purgedAfterCooldown({ s: "x".repeat(200) }, "bash", 10);
    expect(result).toBe(messages);
  });

  it("eligible body made only of short strings is returned by identity", () => {
    const original: Record<string, string> = {};
    for (let i = 0; i < 600; i++) original[`k${i}`] = "v";
    const { messages, result } = purgedAfterCooldown(original, "bash", 500);
    expect(result).toBe(messages);
  });

  it("a second pass over purged output returns the same reference", () => {
    const { result } = purgedAfterCooldown({ path: "src/foo.ts", content: "x".repeat(1000) }, "write", 10);
    expect(purgeErroredArgs(result, { ...defaultConfig, cooldownTurns: 2, minArgChars: 10 })).toBe(result);
  });

  it("preserves own JSON keys even when a key is __proto__", () => {
    const original = JSON.parse(`{"__proto__":"${LONG}","content":"${LONG}"}`);
    const { args } = purgedAfterCooldown(original, "write", 10);
    expect(Object.keys(args)).toEqual(Object.keys(original));
    expect(args.__proto__).toBe('<purged-errored-args size="300"/>');
  });

  it("never mutates the original nested arguments", () => {
    const original = { path: "src/foo.ts", edits: [{ oldText: "a".repeat(300), newText: "x" }] };
    const snapshot = structuredClone(original);
    purgedAfterCooldown(original, "edit", 10);
    expect(original).toEqual(snapshot);
  });
});
