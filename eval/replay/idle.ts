import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { extractToolResultText, projectBranchMessages } from "../../src/batch-capture.js";
import { BlockRefIssuer } from "../../src/block-refs.js";
import { compressEligible } from "../../src/chain-compressor.js";
import { detectChains } from "../../src/chain-detector.js";
import { isPerBatchSummaryMessage, perBatchSummaryOverlapsDropped, resolveRange } from "../../src/chain-range-prune.js";
import { loadConfig } from "../../src/config.js";
import { idleCleanupDue } from "../../src/idle-pause.js";
import { ToolCallIndexer } from "../../src/indexer.js";
import { occKey, resultTimestampOf } from "../../src/occurrence-key.js";
import { isProtected } from "../../src/protected.js";
import { pruneMessages, sizeMessages } from "../../src/pruner.js";
import { inGraceRecoveryToolCallIds } from "../../src/recovery-grace.js";
import { activateClosedChainSuperseded, createSupersedeState, findSuperseded, supersededStub } from "../../src/supersede.js";
import type { ChainCompressionEntry, ContextPruneConfig } from "../../src/types.js";
import { assertOutsideRepo } from "./paths.js";

export interface IdleOptions { inputs: string[]; out?: string; minutes?: number }
export function parseIdleArgs(args: string[]): IdleOptions {
  const options: IdleOptions = { inputs: [] };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { options.inputs.push(arg); continue; }
    if (!["--out", "--minutes"].includes(arg) || seen.has(arg)) throw Error("Invalid idle option");
    seen.add(arg);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error("Missing idle option value");
    if (arg === "--out") options.out = value;
    else {
      options.minutes = Number(value);
      if (!Number.isFinite(options.minutes) || options.minutes <= 0) throw Error("--minutes must be positive and finite");
    }
  }
  if (!options.inputs.length) throw Error("Usage: idle <session-dir>... [--out <dir>] [--minutes <n>]");
  return options;
}

const textOf = (message: any): string => typeof message.content === "string" ? message.content
  : (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");

const occurrence = (message: any): string => occKey(message.toolCallId, resultTimestampOf(message.timestamp));

/** `registered` holds the chain entries that existed before the pause; `request` is the unpruned message array. */
export function preservationViolations(before: any[], after: any[], compressed: ChainCompressionEntry[], config: ContextPruneConfig, neverSummarized: Set<string>,
  request: any[], registered: ChainCompressionEntry[], pointerResults = new Set<string>()) {
  let violations = 0, pointerResultsChecked = 0;
  const text = after.map(message => message.role === "toolResult" ? extractToolResultText(message) : textOf(message));
  const contains = (value: string) => text.some(part => part.includes(value));
  const exact = new Set(after.map(message => JSON.stringify(message)));
  const closed = detectChains(before).map(chain => ({ chain, range: resolveRange(chain, before) })).filter(item => item.range !== null);
  const newRanges = compressed.flatMap(entry => {
    const range = resolveRange(entry, before);
    return range ? [{ ...range, blockId: entry.blockId }] : [];
  });
  const protectedPositions = new Set<number>();
  let calls = new Map<string, any>();
  before.forEach((message, i) => {
    if (message.role === "assistant") calls = new Map((message.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => [b.id, b]));
    else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (call && isProtected(call.name, call.input ?? call.args ?? call.arguments, config, message.nestedCalls)) protectedPositions.add(i);
    } else calls.clear();
  });
  const waitingCandidates = (messages: any[]) => new Map(findSuperseded(messages, (name, args) => isProtected(name, args, config))
    .map(candidate => [candidate.resultIndex, candidate]));
  const superseded = waitingCandidates(before), relocated = waitingCandidates(request);
  // A chain compressed before the pause trades a waiting superseded candidate's block for the placeholder, and nothing else.
  const withPlaceholders = (message: any): any => {
    const entry = registered.find(entry => textOf(message).startsWith(`<compressed-chain id="${entry.blockId}"`));
    const range = entry ? resolveRange(entry, request) : null;
    if (!entry || !range) return message;
    const relocatedIds = new Set(entry.protectedToolCallIds ?? []);
    let text = textOf(message), cursor = 0;
    for (let i = range.startIndex + 1; i < range.endIndex; i++) {
      const result = request[i];
      if (result.role !== "toolResult" || !(relocatedIds.has(result.toolCallId) || relocatedIds.has(occurrence(result)))) continue;
      const block = (body: string) => `<protected-output tool="${result.toolName}">\n${body}\n</protected-output>`;
      const raw = block(extractToolResultText(result)), at = text.indexOf(raw, cursor), candidate = relocated.get(i);
      if (at < 0) return message;
      const kept = candidate ? block(supersededStub(candidate.path)) : raw;
      text = text.slice(0, at) + kept + text.slice(at + raw.length);
      cursor = at + kept.length;
    }
    return { ...message, content: [{ type: "text", text }] };
  };
  const lastOpening = closed.at(-1)?.range!.startIndex ?? -1;
  before.forEach((message, i) => {
    const owner = closed.find(({ chain, range }) => (i >= range!.startIndex && i <= range!.endIndex) ||
      (isPerBatchSummaryMessage(message) && perBatchSummaryOverlapsDropped(message, new Set(chain.middleOccurrenceKeys), new Set(chain.middleToolCallIds))));
    if (message.role === "user" && !exact.has(JSON.stringify(message)) && !exact.has(JSON.stringify(withPlaceholders(message)))) violations++;
    if (isPerBatchSummaryMessage(message) && !contains(textOf(message))) violations++;
    if (newRanges.some(range => range!.endIndex === i) && !contains(textOf(message))) violations++;
    if (protectedPositions.has(i)) {
      const candidate = superseded.get(i);
      const replaced = candidate && contains(supersededStub(candidate.path));
      if (!replaced && !contains(extractToolResultText(message))) violations++;
    }
    const compressedOwner = newRanges.find(range => i > range.startIndex && i < range.endIndex);
    if (message.role === "toolResult" && compressedOwner && neverSummarized.has(occurrence(message))) {
      if (pointerResults.has(occurrence(message))) {
        pointerResultsChecked++;
        const block = `<protected-output tool="${message.toolName}">\n${extractToolResultText(message)}\n</protected-output>`;
        const relocated = after.find(part => part.role === "user" && textOf(part).startsWith(`<compressed-chain id="${compressedOwner.blockId}"`));
        const body = relocated ? textOf(relocated) : "", end = body.lastIndexOf("\n</compressed-chain>");
        if (end < 0 || !body.slice(0, end).includes(block)) violations++;
      } else if (!protectedPositions.has(i) && !contains(extractToolResultText(message))) violations++;
    }
    if (i > lastOpening && !owner && !exact.has(JSON.stringify(message))) violations++;
  });
  return { violations, pointerResultsChecked };
}

export async function replayIdleSessions(options: IdleOptions, config: ContextPruneConfig, render = pruneMessages) {
  const out = assertOutsideRepo(options.out ?? mkdtempSync(join(tmpdir(), "pi-condense-idle-")));
  mkdirSync(out, { recursive: true });
  const report = {
    sessionsRead: 0, sessionsSkipped: 0, returnsFound: 0, returnsChecked: 0, violations: 0, pointerResultsChecked: 0,
    estimatedTokensRemoved: 0, medianPromptShareRemoved: 0,
    protectedOutputComparison: "extracted text, including image marker text; not original image blocks",
    violationRecords: [] as { sessionStem: string; entryIndex: number }[],
  };
  const shares: number[] = [];
  for (const input of options.inputs) {
    for (const file of readdirSync(input).filter(file => file.endsWith(".jsonl")).sort()) {
      let branch: SessionEntry[];
      try {
        const path = join(input, file);
        branch = SessionManager.open(path).getBranch();
      } catch { report.sessionsSkipped++; continue; }
      report.sessionsRead++;
      for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
        const entry = branch[entryIndex];
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const prefix = branch.slice(0, entryIndex), now = Date.parse(entry.timestamp);
        if (!idleCleanupDue({ branch: prefix, now, thresholdMinutes: options.minutes ?? config.chainCompression.idleCleanupMinutes })) continue;
        report.returnsFound++;
        if (!config.enabled || !config.chainCompression.enabled || config.pruneOn === "on-demand") continue;
        const indexer = new ToolCallIndexer();
        indexer.reconstructFromSession({ sessionManager: { getBranch: () => prefix } } as any);
        const messages = projectBranchMessages(prefix);
        const request = [...messages, entry.message];
        const predicate = (name: string, args: unknown, nested?: any) => isProtected(name, args, config, nested);
        const state = createSupersedeState(), registered = indexer.getChainEntries();
        const before = render(request, indexer, config.chainCompression, config.purgeErrors, config, config.recoveryGraceTurns, undefined, { state, isProtected: predicate }).messages;
        const neverSummarized = new Set(before.filter(message => message.role === "toolResult" &&
          !indexer.hasPerBatchSummaryCoveringAny([occurrence(message)])).map(occurrence));
        // Compare pointer stubs to the unchanged render, not the original result text.
        const pointerResults = new Set([...neverSummarized].filter(key =>
          indexer.isDedupAlias(key) || indexer.getIndex().get(key)?.spillPath));
        activateClosedChainSuperseded(messages, state, predicate);
        const blockRefs = new BlockRefIssuer();
        blockRefs.rebuildFrom(indexer.getChainEntries().map(entry => entry.blockId));
        const result = await compressEligible(detectChains(messages, predicate), 0, {
          indexer, blockRefs, messages, literalSummary: true, now: () => now,
          appendEntry: (customType, data) => { prefix.push({ type: "custom", customType, data } as SessionEntry); },
          diagnostics: { report: () => {} },
          // Replay is read-only. Keep recovery records inline instead of spilling
          // private result bodies to a sidecar or the source session directory.
          backfill: { spillThreshold: Infinity, spillPreviewBytes: config.spillPreviewBytes, sessionDir: out, sessionId: "idle" },
        }, inGraceRecoveryToolCallIds(messages, config.recoveryGraceTurns));
        const after = render(request, indexer, config.chainCompression, config.purgeErrors, config, config.recoveryGraceTurns, undefined, { state, isProtected: predicate }).messages;
        const { violations, pointerResultsChecked } = preservationViolations(before, after, result.compressedEntries, config, neverSummarized, request, registered, pointerResults);
        report.pointerResultsChecked += pointerResultsChecked;
        report.returnsChecked++;
        report.violations += violations;
        if (violations) report.violationRecords.push({ sessionStem: basename(file, ".jsonl"), entryIndex });
        const beforeSize = sizeMessages(before), removed = beforeSize - sizeMessages(after);
        report.estimatedTokensRemoved += removed / 4;
        shares.push(beforeSize ? removed / beforeSize : 0);
      }
    }
  }
  shares.sort((a, b) => a - b);
  const middle = Math.floor(shares.length / 2);
  report.medianPromptShareRemoved = shares.length ? shares.length % 2 ? shares[middle] : (shares[middle - 1] + shares[middle]) / 2 : 0;
  writeFileSync(assertOutsideRepo(join(out, "idle.json")), JSON.stringify(report, null, 2));
  return report;
}

export async function idleMain(args: string[], print: (text: string) => void): Promise<number> {
  const options = parseIdleArgs(args);
  // Refuse the destination before loading settings or reading any sessions.
  if (options.out) options.out = assertOutsideRepo(options.out);
  const report = await replayIdleSessions(options, await loadConfig());
  const { violationRecords: _, ...aggregate } = report;
  print(JSON.stringify(aggregate));
  return report.violations || report.sessionsSkipped ? 1 : 0;
}
