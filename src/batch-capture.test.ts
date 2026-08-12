import { describe, expect, test } from "bun:test";
import { captureBatch, captureUnindexedBatchesFromSession, serializeBatchForSummarizer } from "./batch-capture.js";
import type { CapturedBatch, CapturedToolCall } from "./types.js";

function toolCall(overrides: Partial<CapturedToolCall> = {}): CapturedToolCall {
  return {
    toolCallId: "id",
    toolName: "read",
    args: {},
    resultText: "ok",
    isError: false,
    ...overrides,
  };
}

function batch(toolCalls: CapturedToolCall[]): CapturedBatch {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls,
  };
}

describe("serializeBatchForSummarizer", () => {
  test("prefixes each tool block with [[N:toolname]] in order", () => {
    const b = batch([
      toolCall({ toolCallId: "a", toolName: "read" }),
      toolCall({ toolCallId: "b", toolName: "bash" }),
    ]);

    const result = serializeBatchForSummarizer(b);

    expect(result).toContain("[[1:read]] Tool: read(");
    expect(result).toContain("[[2:bash]] Tool: bash(");
  });

  test("numbering is contiguous 1..N regardless of toolCallId values", () => {
    const b = batch([
      toolCall({ toolCallId: "zzz", toolName: "read" }),
      toolCall({ toolCallId: "aaa", toolName: "read" }),
      toolCall({ toolCallId: "mmm", toolName: "write" }),
    ]);

    const result = serializeBatchForSummarizer(b);

    expect(result).toContain("[[1:read]] Tool:");
    expect(result).toContain("[[2:read]] Tool:");
    expect(result).toContain("[[3:write]] Tool:");
  });
});

describe("occurrence capture", () => {
  test("captureBatch records the matched result's timestamp", () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "bash_23", name: "bash", input: { cmd: "ls" } }],
      timestamp: 2100,
    };
    const results = [
      { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2150 },
    ];
    const batch = captureBatch(message, results, 0, 9999);
    expect(batch.toolCalls[0].resultTimestamp).toBe(2150);
  });

  test("captureBatch omits resultTimestamp when no result matched", () => {
    const message = { role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", input: {} }], timestamp: 1 };
    const batch = captureBatch(message, [], 0, 9999);
    expect(batch.toolCalls[0].resultTimestamp).toBeUndefined();
    expect("resultTimestamp" in batch.toolCalls[0]).toBe(false);
    expect(batch.toolCalls[0].resultText).toBe("(no result)");
  });

  test("rescan pairs each assistant with the results of its OWN turn when ids repeat", () => {
    const entry = (message: any) => ({ type: "message", message, timestamp: undefined });
    const branch = [
      entry({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 }),
      entry({ role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 1100 }),
      entry({ role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "FIRST" }], isError: false, timestamp: 1150 }),
      entry({ role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 2100 }),
      entry({ role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "SECOND" }], isError: false, timestamp: 2150 }),
    ];
    const batches = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false });
    expect(batches).toHaveLength(2);
    expect(batches[0].toolCalls[0].resultText).toBe("FIRST");
    expect(batches[0].toolCalls[0].resultTimestamp).toBe(1150);
    expect(batches[1].toolCalls[0].resultText).toBe("SECOND");
    expect(batches[1].toolCalls[0].resultTimestamp).toBe(2150);
  });

  test("rescan asks isSummarized with the occurrence key, not the bare id", () => {
    const asked: string[] = [];
    const entry = (message: any) => ({ type: "message", message });
    const branch = [
      entry({ role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 1100 }),
      entry({ role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1150 }),
    ];
    captureUnindexedBatchesFromSession(branch, { isSummarized: (id: string) => (asked.push(id), false) });
    expect(asked).toContain("bash_23@1150");
  });

  test("rescan still skips a call whose result has not arrived", () => {
    const entry = (message: any) => ({ type: "message", message });
    const branch = [
      entry({ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "bash", input: {} }], timestamp: 1 }),
    ];
    expect(captureUnindexedBatchesFromSession(branch, { isSummarized: () => false })).toEqual([]);
  });

  test("rescan does not pair a result that falls outside its own assistant's turn window", () => {
    // bash_23's result lands AFTER the next assistant message, i.e. in the
    // second assistant's window, not the first's. Per-turn scanning does not
    // fabricate a pair for the first assistant (no in-window result), and the
    // second assistant has no bash_23 call to attach the result to either, so
    // no batch is emitted at all.
    const entry = (message: any) => ({ type: "message", message });
    const branch = [
      entry({ role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 1000 }),
      entry({ role: "assistant", content: [{ type: "toolCall", id: "other", name: "bash", input: {} }], timestamp: 1100 }),
      entry({ role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "late" }], isError: false, timestamp: 1150 }),
    ];
    expect(captureUnindexedBatchesFromSession(branch, { isSummarized: () => false })).toEqual([]);
  });
});
