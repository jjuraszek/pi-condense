import { describe, expect, test } from "bun:test";
import { serializeBatchForSummarizer } from "./batch-capture.js";
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
