import { describe, expect, test } from "bun:test";
import { registerQueryTool } from "./query-tool.js";
import { imageDigest } from "./batch-capture.js";
import { ToolCallIndexer } from "./indexer.js";
import type { CapturedBatch } from "./types.js";

const capture = (idx: ToolCallIndexer, id: string, ts: number, text: string, turnIndex: number) => {
  const batch: CapturedBatch = {
    turnIndex,
    timestamp: ts - 50,
    assistantText: "",
    toolCalls: [{ toolCallId: id, toolName: "bash", args: { cmd: "ls" }, resultText: text, isError: false, resultTimestamp: ts }],
  };
  idx.addBatch(batch, () => {});
};

const captureLegacy = (idx: ToolCallIndexer, id: string, timestamp: number, text: string, turnIndex: number) => {
  const batch: CapturedBatch = {
    turnIndex,
    timestamp,
    assistantText: "",
    toolCalls: [{ toolCallId: id, toolName: "bash", args: { cmd: "ls" }, resultText: text, isError: false }],
  };
  idx.addBatch(batch, () => {});
};

const runToolResult = async (indexer: ToolCallIndexer, toolCallIds: string[], branch: any[] = []): Promise<any> => {
  let registered: any;
  registerQueryTool({ registerTool: (def: any) => (registered = def) } as any, indexer);
  return registered.execute("call-1", { toolCallIds }, undefined, undefined, { sessionManager: { getBranch: () => branch } });
};

const runTool = async (indexer: ToolCallIndexer, toolCallIds: string[], branch: any[] = []): Promise<string> =>
  (await runToolResult(indexer, toolCallIds, branch)).content[0].text as string;

const png = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const branchWith = (...images: any[]) => [
  { type: "message", message: { role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "Read image file [image/png]" }, ...images] } },
];
const markerText = (data: string) => `[image returned: image/png sha256:${imageDigest(data)}]\nRead image file [image/png]`;

describe("context_tree_query image recovery", () => {
  test("short ref returns only the image named by its marker", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "read_1", 1150, markerText("AAAA"), 0);
    idx.registerSummaryRefs([{ shortId: "t1", toolCallId: "read_1", resultTimestamp: 1150 }]);
    const result = await runToolResult(idx, ["t1"], branchWith(png("AAAA"), png("BBBB")));
    expect(result.content[0].type).toBe("text");
    expect(result.content.slice(1)).toEqual([png("AAAA")]);
  });

  test("explicit occurrence key returns the image", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "read_1", 1150, markerText("AAAA"), 0);
    const result = await runToolResult(idx, ["read_1@1150"], branchWith(png("AAAA")));
    expect(result.content.slice(1)).toEqual([png("AAAA")]);
  });

  test("bare alias id returns its original's image", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "read_1", 1150, markerText("AAAA"), 0);
    idx.registerDuplicate("read_2@2150", "read_1@1150", () => {});
    const result = await runToolResult(idx, ["read_2"], branchWith(png("AAAA")));
    expect(result.content.slice(1)).toEqual([png("AAAA")]);
  });

  test("legacy record without marker returns text only", async () => {
    const idx = new ToolCallIndexer();
    captureLegacy(idx, "read_1", 1000, "Read image file [image/png]", 0);
    expect((await runToolResult(idx, ["read_1"], branchWith(png("AAAA")))).content).toHaveLength(1);
  });

  test("image off the current branch returns text only", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "read_1", 1150, markerText("AAAA"), 0);
    expect((await runToolResult(idx, ["read_1"], branchWith(png("BBBB")))).content).toHaveLength(1);
  });

  test("pre-change alias between different images returns text only", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "read_1", 1150, "Read image file [image/png]", 0);
    idx.registerDuplicate("read_2@2150", "read_1@1150", () => {});
    expect((await runToolResult(idx, ["read_2"], branchWith(png("AAAA"), png("BBBB")))).content).toHaveLength(1);
  });

  test("description mentions image blocks", () => {
    let registered: any;
    registerQueryTool({ registerTool: (def: any) => (registered = def) } as any, new ToolCallIndexer());
    expect(registered.description).toContain("image blocks");
  });
});

describe("context_tree_query occurrence handling", () => {
  test("a bare id with two occurrences returns both blocks, chronologically", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "bash_23", 2150, "SECOND", 1);
    capture(idx, "bash_23", 1150, "FIRST", 0);
    const text = await runTool(idx, ["bash_23"]);
    expect(text.indexOf("FIRST")).toBeGreaterThan(-1);
    expect(text.indexOf("SECOND")).toBeGreaterThan(-1);
    expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
    expect(text.match(/## toolRef:/g)).toHaveLength(2);
  });

  test("an occurrence key returns exactly one block", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "bash_23", 1150, "FIRST", 0);
    capture(idx, "bash_23", 2150, "SECOND", 1);
    const text = await runTool(idx, ["bash_23@2150"]);
    expect(text.match(/## toolRef:/g)).toHaveLength(1);
    expect(text).toContain("SECOND");
  });

  test("an unknown id still reports not-found once", async () => {
    const idx = new ToolCallIndexer();
    const text = await runTool(idx, ["nope"]);
    expect(text).toContain("not found in index");
  });

  test("a single match still labels with the caller's input and has no @ suffix", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "bash_23", 1150, "FIRST", 0);
    const text = await runTool(idx, ["bash_23"]);
    expect(text.match(/## toolRef:/g)).toHaveLength(1);
    expect(text).toContain("## toolRef: bash_23\n");
    expect(text).not.toContain("bash_23@");
  });

  test("G5 conformance: a bare id whose collision was content-deduplicated still returns both occurrences via context_tree_query", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "bash_23", 1150, "SAME", 0);
    // Same bare id, later occurrence, content-deduplicated against the original.
    idx.registerDuplicate("bash_23@9150", "bash_23@1150", () => {});

    const records = idx.getRecordsForId("bash_23");
    expect(records).toHaveLength(2);

    const text = await runTool(idx, ["bash_23"]);
    expect(text.match(/## toolRef:/g)).toHaveLength(2);
    expect(text).toContain("bash_23@1150");
    expect(text).toContain("bash_23@9150");
  });

  test("G4/C1: colliding short refs each resolve to their OWN batch through the registered tool", async () => {
    const idx = new ToolCallIndexer();
    capture(idx, "bash_23", 1150, "FIRST", 0);
    capture(idx, "bash_23", 2150, "SECOND", 1);
    idx.registerSummaryRefs([
      { shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 },
      { shortId: "t2", toolCallId: "bash_23", resultTimestamp: 2150 },
    ]);

    const firstText = await runTool(idx, ["t1"]);
    expect(firstText.match(/## toolRef:/g)).toHaveLength(1);
    expect(firstText).toContain("FIRST");
    expect(firstText).not.toContain("SECOND");

    const secondText = await runTool(idx, ["t2"]);
    expect(secondText.match(/## toolRef:/g)).toHaveLength(1);
    expect(secondText).toContain("SECOND");
    expect(secondText).not.toContain("FIRST");
  });

  test("mixed legacy + new occurrence under the same bare id: legacy record labels with the bare id plus an explicit note, not a fake @legacy key", async () => {
    const idx = new ToolCallIndexer();
    captureLegacy(idx, "bash_23", 1000, "OLD", 0);
    capture(idx, "bash_23", 2150, "NEW", 1);
    const text = await runTool(idx, ["bash_23"]);
    expect(text.match(/## toolRef:/g)).toHaveLength(2);
    expect(text).toContain("## toolRef: bash_23\n");
    expect(text).toContain("Occurrence: legacy (no resultTimestamp)");
    expect(text).toContain("bash_23@2150");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("@legacy");
  });

  test("backfilled record (turnIndex -1) renders 'Turn: -1' (cosmetic pin, ref #10)", async () => {
    const idx = new ToolCallIndexer();
    const appended: Array<{ type: string; data: any }> = [];
    await idx.backfillChainRecords(
      [
        {
          toolCallId: "bash_bf",
          toolName: "bash",
          args: { command: "ls" },
          resultText: "backfilled-output",
          isError: false,
          turnIndex: -1,
          timestamp: 1,
          resultTimestamp: 1,
        },
      ],
      {
        spillThreshold: 100_000,
        spillPreviewBytes: 500,
        sessionDir: "/tmp/unused",
        sessionId: "test-session",
        appendEntry: (type: string, data?: unknown) => appended.push({ type, data }),
      },
    );

    const text = await runTool(idx, ["bash_bf@1"]);
    expect(text).toContain("Turn: -1");
  });
});
