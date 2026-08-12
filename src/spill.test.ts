import { describe, it, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeId, blobDirFor, blobPathFor, headPreview, spillOversizedBatch } from "./spill.js";
import { ToolCallIndexer } from "./indexer.js";
import { registerQueryTool } from "./query-tool.js";
import { occKey } from "./occurrence-key.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";
import type { CapturedBatch } from "./types.js";

describe("sanitizeId", () => {
  it("replaces path separators and unsafe chars", () => {
    expect(sanitizeId("toolu_abc-123")).toBe("toolu_abc-123");
    expect(sanitizeId("../../etc/passwd")).toBe("______etc_passwd");
    expect(sanitizeId("a/b\\c")).toBe("a_b_c");
  });
});

describe("blobDirFor / blobPathFor", () => {
  it("builds <sessionDir>/<sessionId>-blobs/<id>.txt", () => {
    expect(blobDirFor("/s", "sid")).toBe(join("/s", "sid-blobs"));
    expect(blobPathFor("/s", "sid", "tc1")).toBe(join("/s", "sid-blobs", "tc1.txt"));
  });
});

describe("headPreview", () => {
  it("returns the whole string when under the byte cap", () => {
    expect(headPreview("hello", 1024)).toBe("hello");
  });
  it("cuts at a line boundary when one exists in budget", () => {
    expect(headPreview("aaaa\nbbbb\ncccc", 7)).toBe("aaaa");
  });
  it("never exceeds the byte cap and stays valid UTF-8", () => {
    const s = "é".repeat(100);
    const out = headPreview(s, 11);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(11);
    expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow();
  });
});

describe("occurrence-keyed spill", () => {
  it("blobPathFor distinguishes two occurrences of one id", () => {
    const a = blobPathFor("/tmp/s", "sess", occKey("bash_23", 1150));
    const b = blobPathFor("/tmp/s", "sess", occKey("bash_23", 3150));
    expect(a).not.toBe(b);
    expect(a.endsWith("bash_23_1150.txt")).toBe(true);
  });

  it("legacy bare-id sidecar path is unchanged", () => {
    expect(blobPathFor("/tmp/s", "sess", "bash_23").endsWith("bash_23.txt")).toBe(true);
  });

  it("registerDuplicate is called with occurrence keys on both sides", async () => {
    const calls: string[][] = [];
    const indexer = {
      lookupByContent: () => "bash_1@1000",
      registerDuplicate: (a: string, b: string) => calls.push([a, b]),
    } as any;
    const batch = {
      turnIndex: 0,
      timestamp: 2000,
      assistantText: "",
      toolCalls: [
        { toolCallId: "bash_2", toolName: "bash", args: {}, resultText: "x".repeat(100), isError: false, resultTimestamp: 2150 },
      ],
    };
    await spillOversizedBatch({
      batch: batch as any,
      indexer,
      config: { spillThreshold: 10, spillPreviewBytes: 10, dedupByContentHash: true },
      sessionDir: "/tmp/s",
      sessionId: "sess",
      appendEntry: () => {},
    });
    expect(calls).toEqual([["bash_2@2150", "bash_1@1000"]]);
  });
});

describe("G4/C4: legacy bare-id sidecar recovery", () => {
  it("a pre-upgrade legacy record whose spillPath points at a bare-id-named sidecar still resolves through context_tree_query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-legacy-"));
    try {
      // A pre-occurrence-key sidecar, written and named exactly the way a
      // pre-upgrade session would have (bare id, no resultTimestamp suffix).
      const sidecarPath = blobPathFor(dir, "sid", "bash_7");
      await mkdir(blobDirFor(dir, "sid"), { recursive: true });
      await writeFile(sidecarPath, "OLD SPILLED BODY".repeat(20));

      const indexEntry = {
        type: "custom",
        customType: CUSTOM_TYPE_INDEX,
        data: {
          toolCalls: [
            {
              toolCallId: "bash_7",
              toolName: "fetch",
              args: { url: "https://x" },
              resultText: "",
              resultPreview: "OLD SPILLED",
              spillPath: sidecarPath,
              spillBytes: 340,
              isError: false,
              turnIndex: 0,
              timestamp: 500,
            },
          ],
        },
      };
      // No matching ToolResultMessage in the branch (a genuinely pre-upgrade,
      // truncated session) - an index entry persisted without resultTimestamp
      // stays bare-keyed (no migration), so its sidecar keeps its bare-id
      // filename and still resolves via the persisted spillPath.
      const indexer = new ToolCallIndexer();
      indexer.reconstructFromSession({ sessionManager: { getBranch: () => [indexEntry] } } as any);
      expect(indexer.hasLegacyBareRecord("bash_7")).toBe(true);

      let registered: any;
      registerQueryTool({ registerTool: (def: any) => (registered = def) } as any, indexer);
      const result = await registered.execute("call-1", { toolCallIds: ["bash_7"] }, undefined, undefined, undefined);
      const text = result.content[0].text as string;

      expect(text).toContain("OLD SPILLED BODY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spillOversizedBatch", () => {
  const cfg = { spillThreshold: 10, spillPreviewBytes: 8, dedupByContentHash: true };
  const mkBatch = (toolCalls: any[]): CapturedBatch => ({ turnIndex: 0, timestamp: 1, assistantText: "", toolCalls });

  it("spills an oversized result: writes file, mutates record, indexes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
      const indexer = new ToolCallIndexer();
      const batch = mkBatch([{ toolCallId: "tc1", toolName: "fetch", args: {}, resultText: "X".repeat(50), isError: false }]);
      const spilled = await spillOversizedBatch({ batch, indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: () => {} });
      expect(spilled.has("tc1")).toBe(true);
      const rec = indexer.getRecord("tc1")!;
      expect(rec.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
      expect(rec.spillBytes).toBe(50);
      expect(rec.resultText).toBe("");
      expect(rec.resultPreview!.length).toBeGreaterThan(0);
      expect(await readFile(rec.spillPath!, "utf-8")).toBe("X".repeat(50));
      expect(indexer.isSummarized("tc1")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves a small result untouched (not spilled)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
      const indexer = new ToolCallIndexer();
      const batch = mkBatch([{ toolCallId: "tc1", toolName: "bash", args: {}, resultText: "tiny", isError: false }]);
      const spilled = await spillOversizedBatch({ batch, indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: () => {} });
      expect(spilled.size).toBe(0);
      expect(indexer.isSummarized("tc1")).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves the tool call untouched when the sidecar write fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "spill-"));
    const filePath = join(base, "not-a-dir");
    await writeFile(filePath, "x"); // sessionDir is a FILE → mkdir under it throws
    try {
      const indexer = new ToolCallIndexer();
      const big = "Z".repeat(50);
      const batch = mkBatch([{ toolCallId: "tc1", toolName: "fetch", args: {}, resultText: big, isError: false }]);
      const spilled = await spillOversizedBatch({ batch, indexer, config: cfg, sessionDir: filePath, sessionId: "sid", appendEntry: () => {} });
      expect(spilled.size).toBe(0);
      expect(indexer.isSummarized("tc1")).toBe(false);
      expect(batch.toolCalls[0].resultText).toBe(big); // untouched
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("two occurrences of one toolCallId spill to distinct sidecar files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
      const indexer = new ToolCallIndexer();
      const batch1 = mkBatch([{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "FIRST".repeat(20), isError: false, resultTimestamp: 1150 }]);
      const batch2 = mkBatch([{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "SECOND".repeat(20), isError: false, resultTimestamp: 3150 }]);
      await spillOversizedBatch({ batch: batch1, indexer, config: { ...cfg, dedupByContentHash: false }, sessionDir: dir, sessionId: "sid", appendEntry: () => {} });
      await spillOversizedBatch({ batch: batch2, indexer, config: { ...cfg, dedupByContentHash: false }, sessionDir: dir, sessionId: "sid", appendEntry: () => {} });
      const rec1 = indexer.getRecord("bash_23@1150")!;
      const rec2 = indexer.getRecord("bash_23@3150")!;
      expect(rec1.spillPath).not.toBe(rec2.spillPath);
      expect(await readFile(rec1.spillPath!, "utf-8")).toBe("FIRST".repeat(20));
      expect(await readFile(rec2.spillPath!, "utf-8")).toBe("SECOND".repeat(20));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("dedups an oversized duplicate to the original without a second file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
      const indexer = new ToolCallIndexer();
      const body = "Y".repeat(50);
      const append = () => {};
      await spillOversizedBatch({ batch: mkBatch([{ toolCallId: "tc1", toolName: "fetch", args: {}, resultText: body, isError: false }]), indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: append });
      const spilled2 = await spillOversizedBatch({ batch: mkBatch([{ toolCallId: "tc2", toolName: "fetch", args: {}, resultText: body, isError: false }]), indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: append });
      expect(spilled2.has("tc2")).toBe(true);
      expect(indexer.isSummarized("tc2")).toBe(true);
      expect(indexer.getRecord("tc2")!.toolCallId).toBe("tc1");
      await expect(readFile(blobPathFor(dir, "sid", "tc2"), "utf-8")).rejects.toBeDefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
