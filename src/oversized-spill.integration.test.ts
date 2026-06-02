import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCallIndexer } from "./indexer.js";
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
      expect((out[0] as any).content[0].text).toContain(blobPathFor(dir, "sid", "tc1"));
      expect((out[0] as any).content[0].text).not.toContain("Summarized in pruner summary");

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
});
