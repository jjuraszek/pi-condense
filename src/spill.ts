import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapturedBatch, CapturedToolCall } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import { hashToolResult } from "./content-hash.js";

/** Replace anything outside [A-Za-z0-9_-] so the id can't escape the blob dir. */
export function sanitizeId(toolCallId: string): string {
  return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function blobDirFor(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}-blobs`);
}

export function blobPathFor(sessionDir: string, sessionId: string, toolCallId: string): string {
  return join(blobDirFor(sessionDir, sessionId), `${sanitizeId(toolCallId)}.txt`);
}

/** Head of `text` capped at `maxBytes` (UTF-8 safe), preferring a line boundary. */
export function headPreview(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  let slice = buf.subarray(0, end).toString("utf8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl > 0) slice = slice.slice(0, lastNl);
  return slice;
}

interface SpillConfig {
  spillThreshold: number;
  spillPreviewBytes: number;
  dedupByContentHash: boolean;
}

export async function spillOversizedBatch(args: {
  batch: CapturedBatch;
  indexer: ToolCallIndexer;
  config: SpillConfig;
  sessionDir: string;
  sessionId: string;
  appendEntry: (customType: string, data?: unknown) => void;
}): Promise<Set<string>> {
  const { batch, indexer, config, sessionDir, sessionId, appendEntry } = args;
  const handled = new Set<string>();
  const toIndex: CapturedToolCall[] = [];

  for (const tc of batch.toolCalls) {
    if (tc.resultText.length < config.spillThreshold) continue;

    const hash = hashToolResult(tc.toolName, tc.resultText);

    if (config.dedupByContentHash) {
      const original = indexer.lookupByContent(tc.toolName, tc.resultText);
      if (original && original !== tc.toolCallId) {
        indexer.registerDuplicate(tc.toolCallId, original, appendEntry);
        handled.add(tc.toolCallId);
        continue;
      }
    }

    const path = blobPathFor(sessionDir, sessionId, tc.toolCallId);
    try {
      await mkdir(blobDirFor(sessionDir, sessionId), { recursive: true });
      await writeFile(path, tc.resultText, "utf-8");
    } catch (err) {
      console.error(`spill: failed to write sidecar for ${tc.toolCallId} at ${path}:`, err);
      continue;
    }

    tc.spillBytes = Buffer.byteLength(tc.resultText, "utf8");
    tc.resultPreview = headPreview(tc.resultText, config.spillPreviewBytes);
    tc.spillPath = path;
    tc.contentHash = hash;
    tc.resultText = "";
    toIndex.push(tc);
    handled.add(tc.toolCallId);
  }

  if (toIndex.length > 0) {
    indexer.addBatch(
      { turnIndex: batch.turnIndex, timestamp: batch.timestamp, assistantText: "", toolCalls: toIndex },
      appendEntry,
    );
  }

  return handled;
}
