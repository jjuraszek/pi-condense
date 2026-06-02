import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeId, blobDirFor, blobPathFor, headPreview, spillOversizedBatch } from "./spill.js";
import { ToolCallIndexer } from "./indexer.js";
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
