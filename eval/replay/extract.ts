import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { captureUnindexedBatchesFromSession } from "../../src/batch-capture.js";
import { occKey, resultTimestampOf } from "../../src/occurrence-key.js";
import { isProtected } from "../../src/protected.js";
import { CUSTOM_TYPE_INDEX, type CapturedBatch } from "../../src/types.js";
import { PIPELINE_SETTINGS } from "../config.js";
import { assertOutsideRepo } from "./paths.js";

export interface ReplayCounts {
  sessionsRead: number;
  sessionsSkipped: number;
  batches: number;
  longResults: number;
  spillPresent: number;
  spillMissing: number;
  protectedExclusions: number;
}
export interface PositionedMessage {
  position: number;
  role: "user" | "assistant";
  text: string;
  toolArgs: unknown[];
}
export interface PositionedResult {
  position: number;
  occurrenceKey: string;
  spilled: boolean;
  sidecar?: "present" | "missing";
}
export interface ReplaySession {
  batches: CapturedBatch[];
  messages: PositionedMessage[];
  batchPositions: { assistantPosition: number; results: PositionedResult[] }[];
  counts: ReplayCounts;
}
const emptyCounts = (): ReplayCounts => ({ sessionsRead: 0, sessionsSkipped: 0, batches: 0, longResults: 0, spillPresent: 0, spillMissing: 0, protectedExclusions: 0 });

export function extractBranch(branch: SessionEntry[]): ReplaySession {
  const counts = emptyCounts();
  counts.sessionsRead = 1;
  const batches = captureUnindexedBatchesFromSession(branch, { isSummarized: () => false }, (name, args) => {
    const excluded = isProtected(name, args, PIPELINE_SETTINGS);
    if (excluded) counts.protectedExclusions++;
    return excluded;
  });
  const spills = new Map<string, string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE_INDEX) continue;
    const data = entry.data as { toolCalls?: { toolCallId: string; resultTimestamp?: number; spillPath?: string }[] } | undefined;
    for (const call of data?.toolCalls ?? []) {
      const key = occKey(call.toolCallId, call.resultTimestamp);
      if (call.spillPath) spills.set(key, call.spillPath);
      else spills.delete(key);
    }
  }
  const messages: PositionedMessage[] = [];
  const assistantPositions: number[] = [];
  branch.forEach((entry, position) => {
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") return;
    if (message.role === "assistant") assistantPositions.push(position);
    const content = message.content;
    messages.push({ position, role: message.role, text: typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("\n"), toolArgs: Array.isArray(content) ? content.filter(c => c.type === "toolCall").map(c => c.arguments) : [] });
  });
  const batchPositions = batches.map(batch => {
    const assistantPosition = assistantPositions[batch.turnIndex];
    const end = assistantPositions[batch.turnIndex + 1] ?? branch.length;
    const results = batch.toolCalls.map(call => {
      const key = occKey(call.toolCallId, call.resultTimestamp);
      const position = branch.findIndex((entry, i) => i > assistantPosition && i < end && entry.type === "message" && entry.message.role === "toolResult" && occKey(entry.message.toolCallId, resultTimestampOf(entry.message.timestamp)) === key);
      const spillPath = spills.get(key);
      if (spillPath) {
        call.resultText = "";
        call.spillPath = spillPath;
        const sidecar = existsSync(spillPath) ? "present" : "missing";
        if (sidecar === "present") counts.spillPresent++;
        else counts.spillMissing++;
        return { position, occurrenceKey: key, spilled: true, sidecar } satisfies PositionedResult;
      }
      if (call.resultText.length > 8000) counts.longResults++;
      return { position, occurrenceKey: key, spilled: false };
    });
    return { assistantPosition, results };
  });
  counts.batches = batches.length;
  return { batches, messages, batchPositions, counts };
}

export function extractSessions(input: string, out = process.env.PI_CONDENSE_REPLAY_DIR ?? join(process.env.TMPDIR ?? tmpdir(), "pi-condense-replay")): ReplayCounts {
  out = assertOutsideRepo(out);
  mkdirSync(out, { recursive: true });
  out = assertOutsideRepo(out);
  const counts = emptyCounts();
  for (const file of readdirSync(input).filter(file => file.endsWith(".jsonl")).sort()) {
    let session: ReplaySession;
    try {
      const path = join(input, file);
      // SessionManager tolerates unreadable input by starting an empty session.
      readFileSync(path, "utf8");
      session = extractBranch(SessionManager.open(path).getBranch());
    } catch {
      counts.sessionsSkipped++;
      continue;
    }
    out = assertOutsideRepo(out);
    const destination = assertOutsideRepo(join(out, `${basename(file, ".jsonl")}.json`));
    writeFileSync(destination, JSON.stringify(session));
    for (const key of Object.keys(counts) as (keyof ReplayCounts)[]) counts[key] += session.counts[key];
  }
  return counts;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "extract") args.shift();
  if (!args[0] || (args.length !== 1 && (args.length !== 3 || args[1] !== "--out"))) {
    console.error("Usage: extract <session-dir> [--out <dir>]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(extractSessions(args[0], args[2])));
    } catch {
      console.error("Replay extraction refused or failed");
      process.exitCode = 1;
    }
  }
}
