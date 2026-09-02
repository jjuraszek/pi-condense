import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { ToolCallIndexer } from "./indexer.js";
import { occKey } from "./occurrence-key.js";
import { spillOversizedBatch, blobPathFor } from "./spill.js";
import { pruneMessages } from "./pruner.js";
import type { CapturedBatch } from "./types.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";

const cfg = { spillThreshold: 10, spillPreviewBytes: 16, dedupByContentHash: true };
const batch = (tc: any): CapturedBatch => ({ turnIndex: 0, timestamp: 1, assistantText: "", toolCalls: [tc] });

describe("oversized spill end-to-end", () => {
  it("spills, stubs in context, keeps full body on disk, survives reconstruct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-e2e-"));
    try {
      const indexer = new ToolCallIndexer();
      const entries: any[] = [];
      const appendEntry = (customType: string, data?: unknown) => {
        entries.push({ type: "custom", customType, data });
      };

      const body = "BIG\n".repeat(1000);
      await spillOversizedBatch({
        batch: batch({ toolCallId: "tc1", toolName: "fetch", args: { url: "u" }, resultText: body, isError: false }),
        indexer,
        config: cfg,
        sessionDir: dir,
        sessionId: "sid",
        appendEntry,
      });

      // (a) full body on disk
      expect(await readFile(blobPathFor(dir, "sid", "tc1"), "utf-8")).toBe(body);

      // (b) persisted index entry has spillPath + preview, NOT the full body
      const idxEntry = entries.find((e) => e.customType === CUSTOM_TYPE_INDEX);
      expect(idxEntry).toBeTruthy();
      const persisted = idxEntry.data.toolCalls[0];
      expect(persisted.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
      expect(persisted.resultText).toBe("");
      expect(persisted.resultPreview.length).toBeGreaterThan(0);
      expect(persisted.contentHash).toBeTruthy();

      // (c) pruneMessages emits the mechanical spill stub (no summary, no LLM)
      const msgs = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "fetch", input: {} }],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "fetch",
          content: [{ type: "text", text: body }],
          isError: false,
          timestamp: 1,
        },
      ];
      const { messages: out, pruned } = pruneMessages(msgs as any, indexer);
      expect(pruned).toBe(true);
      expect((out[1] as any).content[0].text).toContain(blobPathFor(dir, "sid", "tc1"));
      expect((out[1] as any).content[0].text).not.toContain("Summarized in pruner summary");

      // (d) reconstruct from the persisted entries: record still resolves, hash intact
      const indexer2 = new ToolCallIndexer();
      const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;
      indexer2.reconstructFromSession(fakeCtx);
      const rec = indexer2.getRecord("tc1");
      expect(rec?.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
      expect(indexer2.lookupByContent("fetch", body)).toBe("tc1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("long-id record survives the backfill -> restart round trip (AC4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-e2e-"));
    try {
      const indexer = new ToolCallIndexer();
      const entries: any[] = [];
      const appendEntry = (customType: string, data?: unknown) => {
        entries.push({ type: "custom", customType, data });
      };
      const longId = "toolu_" + "q".repeat(494); // 500 chars
      const body = "BACKFILL BODY\n".repeat(200);
      const rec: any = {
        toolCallId: longId, toolName: "bash", args: { command: "ls" },
        resultText: body, isError: false, turnIndex: -1, timestamp: 1000, resultTimestamp: 1000,
      };

      // 1. backfill write: must not throw (fail-closed path), basename capped
      await indexer.backfillChainRecords([rec], {
        spillThreshold: 10, spillPreviewBytes: 16, sessionDir: dir, sessionId: "sid", appendEntry,
      });
      expect(rec.spillPath).toBeTruthy();
      expect(Buffer.byteLength(basename(rec.spillPath), "utf8")).toBeLessThanOrEqual(255);

      // 2. persisted index entry exists (backfilled shape)
      expect(entries.some((e) => e.customType === CUSTOM_TYPE_INDEX && e.data.backfilled)).toBe(true);

      // 3. restart: fresh indexer reconstructs from persisted entries only
      const rebuilt = new ToolCallIndexer();
      rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => entries } } as any);
      const restored = rebuilt.getRecord(occKey(longId, 1000))!;
      expect(restored.spillPath).toBe(rec.spillPath);

      // 4. read-back of the restored persisted path equals the original body
      expect(await readFile(restored.spillPath!, "utf-8")).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("capped names are namespace-disjoint from short-key names", () => {
    const cappedPath = blobPathFor("/s", "sid", "a".repeat(300));
    const stem = basename(cappedPath).slice(0, -".txt".length);
    // sanitizeId can never emit ".", so no short key maps onto a capped name -
    // even the short key spelled exactly like the capped stem.
    expect(stem).toContain(".");
    expect(blobPathFor("/s", "sid", stem)).not.toBe(cappedPath);
  });
});
