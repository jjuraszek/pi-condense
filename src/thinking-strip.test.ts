import { describe, expect, test } from "bun:test";
import { stripOldThinking } from "./thinking-strip.js";
import type { ThinkingStripConfig } from "./types.js";

const cfg = (enabled: boolean, keepLastTurns: number): ThinkingStripConfig => ({ enabled, keepLastTurns });

function userMsg(ts: number): any {
  return { role: "user", content: [{ type: "text", text: "go" }], timestamp: ts };
}

function assistantToolsThinking(ts: number, toolCallIds: string[], thinkingBlocks = 1): any {
  const content: any[] = [];
  for (let i = 0; i < thinkingBlocks; i++) {
    content.push({ type: "thinking", thinking: `t${ts}-${i}`, thinkingSignature: `sig${ts}-${i}` });
  }
  content.push({ type: "text", text: "working" });
  for (const id of toolCallIds) content.push({ type: "toolCall", id, name: "bash", arguments: { cmd: "ls" } });
  return { role: "assistant", content, timestamp: ts, usage: {}, stopReason: "toolUse" };
}

function assistantTextThinking(ts: number): any {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "final reasoning", thinkingSignature: "sigf" },
      { type: "text", text: "done" },
    ],
    timestamp: ts,
    usage: {},
    stopReason: "stop",
  };
}

function toolResult(ts: number, toolCallId: string): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "out" }],
    isError: false,
    timestamp: ts,
  };
}

function hasThinking(msg: any): boolean {
  return Array.isArray(msg.content) && msg.content.some((c: any) => c.type === "thinking");
}

function countThinking(msg: any): number {
  return Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "thinking").length : 0;
}

/** user, then (n-1) tool-using assistant turns each followed by a toolResult, then 1 final text assistant. */
function convo(nAssistantTurns: number): any[] {
  const msgs: any[] = [userMsg(1)];
  let ts = 2;
  for (let i = 0; i < nAssistantTurns - 1; i++) {
    const id = `tc${i}`;
    msgs.push(assistantToolsThinking(ts++, [id]));
    msgs.push(toolResult(ts++, id));
  }
  msgs.push(assistantTextThinking(ts++));
  return msgs;
}

describe("stripOldThinking", () => {
  test("disabled → same reference", () => {
    const msgs = convo(20);
    expect(stripOldThinking(msgs, cfg(false, 16))).toBe(msgs);
  });

  test("fewer assistant turns than keepLastTurns → same reference", () => {
    const msgs = convo(10);
    expect(stripOldThinking(msgs, cfg(true, 16))).toBe(msgs);
  });

  test("exactly keepLastTurns assistant turns → same reference (nothing older)", () => {
    const msgs = convo(16);
    expect(stripOldThinking(msgs, cfg(true, 16))).toBe(msgs);
  });

  test("strips thinking from turns older than the last K, keeps the last K", () => {
    const msgs = convo(20);
    const out = stripOldThinking(msgs, cfg(true, 16));
    expect(out).not.toBe(msgs);
    const assistants = out.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(20);
    for (const a of assistants.slice(-16)) expect(hasThinking(a)).toBe(true);
    for (const a of assistants.slice(0, 4)) expect(hasThinking(a)).toBe(false);
  });

  test("keepLastTurns=1 keeps only the most-recent assistant turn's thinking", () => {
    const msgs = convo(5);
    const out = stripOldThinking(msgs, cfg(true, 1));
    const assistants = out.filter((m) => m.role === "assistant");
    expect(hasThinking(assistants[assistants.length - 1])).toBe(true);
    for (const a of assistants.slice(0, -1)) expect(hasThinking(a)).toBe(false);
  });

  test("keepLastTurns=0 is clamped to 1 (never strips the last assistant turn)", () => {
    const msgs = convo(5);
    const out = stripOldThinking(msgs, cfg(true, 0));
    const assistants = out.filter((m) => m.role === "assistant");
    expect(hasThinking(assistants[assistants.length - 1])).toBe(true);
    expect(hasThinking(assistants[0])).toBe(false);
  });

  test("trailing tool-use assistant awaiting results keeps its thinking", () => {
    const msgs: any[] = [userMsg(1)];
    let ts = 2;
    for (let i = 0; i < 4; i++) {
      const id = `x${i}`;
      msgs.push(assistantToolsThinking(ts++, [id]));
      msgs.push(toolResult(ts++, id));
    }
    const out = stripOldThinking(msgs, cfg(true, 1));
    const assistants = out.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1];
    expect(hasThinking(last)).toBe(true);
    expect(last.content.some((c: any) => c.type === "toolCall")).toBe(true);
  });

  test("stripped assistant keeps its text and toolCall blocks", () => {
    const msgs = convo(20);
    const out = stripOldThinking(msgs, cfg(true, 16));
    const firstAssistant = out.find((m) => m.role === "assistant");
    expect(hasThinking(firstAssistant)).toBe(false);
    expect(firstAssistant.content.some((c: any) => c.type === "text")).toBe(true);
    expect(firstAssistant.content.some((c: any) => c.type === "toolCall")).toBe(true);
  });

  test("strips all thinking blocks from a message (all-or-nothing)", () => {
    const msgs: any[] = [userMsg(1), assistantToolsThinking(2, ["a"], 2), toolResult(3, "a")];
    let ts = 4;
    for (let i = 0; i < 3; i++) {
      const id = `b${i}`;
      msgs.push(assistantToolsThinking(ts++, [id], 2));
      msgs.push(toolResult(ts++, id));
    }
    msgs.push(assistantTextThinking(ts++));
    const out = stripOldThinking(msgs, cfg(true, 2));
    expect(countThinking(out[1])).toBe(0);
  });

  test("no thinking anywhere → same reference", () => {
    const msgs: any[] = [userMsg(1)];
    let ts = 2;
    for (let i = 0; i < 20; i++) {
      const id = `n${i}`;
      msgs.push({
        role: "assistant",
        content: [{ type: "text", text: "x" }, { type: "toolCall", id, name: "bash", arguments: {} }],
        timestamp: ts++,
        usage: {},
        stopReason: "toolUse",
      });
      msgs.push(toolResult(ts++, id));
    }
    expect(stripOldThinking(msgs, cfg(true, 4))).toBe(msgs);
  });

  test("idempotent: second pass returns same reference", () => {
    const msgs = convo(20);
    const once = stripOldThinking(msgs, cfg(true, 16));
    const twice = stripOldThinking(once, cfg(true, 16));
    expect(twice).toBe(once);
  });

  test("preserves message order and length", () => {
    const msgs = convo(20);
    const out = stripOldThinking(msgs, cfg(true, 16));
    expect(out.length).toBe(msgs.length);
    out.forEach((m, i) => expect(m.role).toBe(msgs[i].role));
  });
});
