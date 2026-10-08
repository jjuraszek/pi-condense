import { describe, expect, test } from "bun:test";
import {
  captureBatch,
  captureUnindexedBatchesFromSession,
  deriveLiveTurnIndex,
  extractToolResultText,
  imageDigest,
  imageMarkerDigests,
  projectBranchMessages,
  serializeBatchForSummarizer,
} from "./batch-capture.js";
import type { CapturedBatch, CapturedToolCall } from "./types.js";
import { ToolCallIndexer } from "./indexer.js";

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

  const MARKER = /^ \.\.\.\[(\d+) chars elided\]\.\.\. $/;

  function resultBody(serialized: string): string {
    const prefix = "Result (OK): ";
    return serialized.slice(serialized.indexOf(prefix) + prefix.length);
  }

  test("a result of 8,000 chars serializes whole with no marker", () => {
    const raw = "a".repeat(8000);
    const body = resultBody(serializeBatchForSummarizer(batch([toolCall({ resultText: raw })])));
    expect(body).toBe(raw);
    expect(body).not.toContain("chars elided");
  });

  test("a result of 8,001 chars becomes head 4,000 + marker + tail 4,000", () => {
    const raw = "h".repeat(4000) + "m" + "t".repeat(4000);
    const body = resultBody(serializeBatchForSummarizer(batch([toolCall({ resultText: raw })])));
    expect(body).toBe("h".repeat(4000) + " ...[1 chars elided]... " + "t".repeat(4000));
    expect(body.length).toBe(8024);
  });

  test("a result of 20,000 chars keeps raw.slice(0, 4000) and raw.slice(16000) around a 12000 marker", () => {
    const raw = Array.from({ length: 20000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const body = resultBody(serializeBatchForSummarizer(batch([toolCall({ resultText: raw })])));
    expect(body.startsWith(raw.slice(0, 4000))).toBe(true);
    expect(body.endsWith(raw.slice(16000))).toBe(true);
    expect(body).toContain(" ...[12000 chars elided]... ");
  });

  test("a sentinel in the last 100 chars of a 5,175-char result survives; one at char 10,000 of 20,000 does not", () => {
    const tailRaw = "x".repeat(5075) + "ERROR_AT_TAIL" + "x".repeat(5175 - 5075 - "ERROR_AT_TAIL".length);
    expect(tailRaw.length).toBe(5175);
    expect(serializeBatchForSummarizer(batch([toolCall({ resultText: tailRaw })]))).toContain("ERROR_AT_TAIL");

    const midRaw = "x".repeat(10000) + "MID_SENTINEL" + "x".repeat(20000 - 10000 - "MID_SENTINEL".length);
    expect(midRaw.length).toBe(20000);
    expect(serializeBatchForSummarizer(batch([toolCall({ resultText: midRaw })]))).not.toContain("MID_SENTINEL");
  });

  test("result body equals raw up to 8,000 and head + marker + tail above, for boundary lengths", () => {
    for (const length of [0, 1, 7999, 8000, 8001, 65535, 1008000]) {
      const raw = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const body = resultBody(serializeBatchForSummarizer(batch([toolCall({ resultText: raw })])));
      if (length <= 8000) {
        expect(body).toBe(raw);
      } else {
        const marker = ` ...[${length - 8000} chars elided]... `;
        expect(marker).toMatch(MARKER);
        expect(body).toBe(raw.slice(0, 4000) + marker + raw.slice(-4000));
        expect(body.length - raw.length).toBeLessThanOrEqual(marker.length);
        expect(body.length).toBe(8000 + 23 + String(length - 8000).length);
      }
    }
  });

  test("labels and Tool: lines are unchanged for windowed results", () => {
    const b = batch([
      toolCall({ toolCallId: "a", toolName: "read", resultText: "r".repeat(9000) }),
      toolCall({ toolCallId: "b", toolName: "bash", resultText: "s".repeat(9000) }),
    ]);

    const result = serializeBatchForSummarizer(b);

    expect(result).toContain("[[1:read]] Tool: read(");
    expect(result).toContain("[[2:bash]] Tool: bash(");
    expect(result.match(/chars elided/g)?.length).toBe(2);
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

describe("captureUnindexedBatchesFromSession entry timestamp fallback", () => {
  test("uses the entry's timestamp when the inner message lacks one", () => {
    const branch = [
      {
        type: "message",
        timestamp: "2026-08-31T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }] },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1150 },
      },
    ];

    const batches = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false });

    expect(batches).toHaveLength(1);
    expect(batches[0].timestamp).toBe(new Date("2026-08-31T10:00:00.000Z").getTime());
  });
});

describe("projectBranchMessages", () => {
  test("projects custom_message entries as role custom and drops unknown entry types", () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        type: "custom_message",
        customType: "x",
        content: "c",
        display: true,
        details: {},
        timestamp: "2026-08-31T10:00:00.000Z",
      },
      { type: "other" },
    ];

    const msgs = projectBranchMessages(branch);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe((branch[0] as any).message);
    expect(msgs[1]).toEqual({
      role: "custom",
      customType: "x",
      content: "c",
      display: true,
      details: {},
      timestamp: new Date("2026-08-31T10:00:00.000Z").getTime(),
    });
  });
});

describe("deriveLiveTurnIndex (#16)", () => {
  // Branch mixing every entry class the projection must classify: tool-calling
  // assistants, a text-only assistant, a custom_message steer, a pruner custom
  // entry, a compaction entry. The last assistant carries a ready, unsummarized
  // tool call so the rescan emits a batch for it.
  function mixedBranch(): any[] {
    return [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc-old", name: "read", arguments: {} }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "tc-old", toolName: "read", content: [{ type: "text", text: "y".repeat(200) }], timestamp: 1 } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "text only" }] } },
      { type: "custom_message", customType: "gauntlet-gate", content: "go", display: true },
      { type: "custom", customType: "context-prune-summary", data: {} },
      { type: "compaction", summary: "..." },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "again" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc-live", name: "read", arguments: {} }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "tc-live", toolName: "read", content: [{ type: "text", text: "x".repeat(200) }], timestamp: 2 } },
    ];
  }

  test("returns the rescan index of the branch's last assistant message (AC5 parity)", () => {
    const branch = mixedBranch();
    // 3 projected assistant messages (tc-old, text-only, tc-live) -> last index 2.
    // custom_message/custom/compaction entries never count.
    expect(deriveLiveTurnIndex(branch)).toBe(2);
    const rescan = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false });
    const liveBatch = rescan.find((b) => b.toolCalls.some((tc) => tc.toolCallId === "tc-live"));
    expect(liveBatch).toBeDefined();
    expect(liveBatch!.turnIndex).toBe(deriveLiveTurnIndex(branch));
  });

  test("returns -1 when the branch has no projected assistant message", () => {
    expect(deriveLiveTurnIndex([])).toBe(-1);
    expect(
      deriveLiveTurnIndex([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]),
    ).toBe(-1);
  });
});

describe("custom-anchor group boundary", () => {
  function buildBranch(customType: string) {
    const entry = (message: any) => ({ type: "message", message });
    return [
      entry({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 }),
      entry({
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }],
        timestamp: 1100,
      }),
      entry({
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "ok1" }],
        isError: false,
        timestamp: 1150,
      }),
      {
        type: "custom_message",
        customType,
        content: "c",
        display: true,
        details: {},
        timestamp: "2026-08-31T10:00:00.000Z",
      },
      entry({
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "bash", input: {} }],
        timestamp: 2100,
      }),
      entry({
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "bash",
        content: [{ type: "text", text: "ok2" }],
        isError: false,
        timestamp: 2150,
      }),
    ];
  }

  test("an eligible custom anchor (pi-gauntlet-transition-recovery) pins a new userTurnGroup", () => {
    const branch = buildBranch("pi-gauntlet-transition-recovery");
    const batches = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false });

    expect(batches).toHaveLength(2);
    expect(batches[0].userTurnGroup).not.toBe(batches[1].userTurnGroup);
  });

  test("a pruner custom (context-prune-summary) passes through without a new group", () => {
    const branch = buildBranch("context-prune-summary");
    const batches = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false });

    expect(batches).toHaveLength(2);
    expect(batches[0].userTurnGroup).toBe(batches[1].userTurnGroup);
  });
});

const img = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

describe("image markers", () => {
  test("markers lead the text, in block order, with mime type and 8-hex hash", () => {
    const text = extractToolResultText({
      content: [{ type: "text", text: "Read image file [image/png]" }, img("AAAA"), img("BBBB", "image/jpeg")],
    });
    expect(text.split("\n")).toEqual([
      `[image returned: image/png sha256:${imageDigest("AAAA")}]`,
      `[image returned: image/jpeg sha256:${imageDigest("BBBB")}]`,
      "Read image file [image/png]",
    ]);
    expect(imageDigest("AAAA")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("same base64 -> same marker, different base64 -> different marker", () => {
    const a1 = extractToolResultText({ content: [img("AAAA")] });
    const a2 = extractToolResultText({ content: [img("AAAA")] });
    const b = extractToolResultText({ content: [img("BBBB")] });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test("text-only content is unchanged", () => {
    expect(extractToolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  test("imageMarkerDigests reads the digests back in marker order", () => {
    const text = extractToolResultText({ content: [img("AAAA"), { type: "text", text: "x" }, img("BBBB")] });
    expect(imageMarkerDigests(text)).toEqual([imageDigest("AAAA"), imageDigest("BBBB")]);
    expect(imageMarkerDigests("no markers here")).toEqual([]);
  });

  test("a result with >8,000 text chars plus an image keeps the marker in the summarizer input", () => {
    const message = { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", input: { path: "a.png" } }], timestamp: 1 };
    const results = [
      { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "x".repeat(9000) }, img("AAAA")], isError: false, timestamp: 2 },
    ];
    const out = serializeBatchForSummarizer(captureBatch(message, results, 0, 9999));
    expect(out).toContain(`[image returned: image/png sha256:${imageDigest("AAAA")}]`);
  });

  test("identical text with different data misses lookupByContent; identical data hits", () => {
    const captureRead = (id: string, data: string, ts: number) =>
      captureBatch(
        { role: "assistant", content: [{ type: "toolCall", id, name: "read", input: { path: "s.png" } }], timestamp: ts },
        [{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, img(data)], isError: false, timestamp: ts + 1 }],
        0,
        ts
      );
    const idx = new ToolCallIndexer();
    idx.addBatch(captureRead("r1", "AAAA", 100), () => {});
    const other = captureRead("r2", "BBBB", 200).toolCalls[0];
    expect(idx.lookupByContent(other.toolName, other.resultText)).toBeUndefined();
    const same = captureRead("r3", "AAAA", 300).toolCalls[0];
    expect(idx.lookupByContent(same.toolName, same.resultText)).toBe("r1@101");
  });
});
