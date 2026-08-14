/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save <agent-dir>/settings.json `contextPrune` namespace (honors PI_CODING_AGENT_DIR)
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<occurrenceKey, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode } from "./src/batch-capture.js";
import { summarizeBatch, summarizeBatches, summarizeRange } from "./src/summarizer.js";
import { FallbackController } from "./src/summarizer-fallback.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { isProtected } from "./src/protected.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { formatSummaryToolCallRefs, makeSummaryDetails, substituteInlineRefs } from "./src/summary-refs.js";
import type {
  ContextPruneConfig,
  CapturedBatch,
  PruneFrontier,
  FlushOptions,
  ContextMetricsSnapshot,
  FlushMetricsEntry,
  FlushTrigger,
} from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
  CUSTOM_TYPE_FLUSH_METRICS,
} from "./src/types.js";
import { computeContextMetrics } from "./src/context-metrics.js";
import { StatsAccumulator, emitExternalCost } from "./src/stats.js";
import { PruneFrontierTracker } from "./src/frontier.js";
import { BlockRefIssuer } from "./src/block-refs.js";
import { compressEligible } from "./src/chain-compressor.js";
import { detectChains, withClosingMessage } from "./src/chain-detector.js";
import { inGraceRecoveryToolCallIds } from "./src/recovery-grace.js";
import { shouldBudgetFlush, shouldDeltaFlush, usageFraction } from "./src/budget.js";
import { spillOversizedBatch } from "./src/spill.js";
import { occKey } from "./src/occurrence-key.js";
import { DiagnosticSink } from "./src/diagnostics.js";

const EMPTY_METRICS_SNAPSHOT: ContextMetricsSnapshot = { openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 };

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG },
  };

  const protectionPredicate = (name: string, args: unknown) => isProtected(name, args, currentConfig.value);

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Session-scoped summarizer outage-fallback controller (in-memory; reset on session_start).
  const fallbackController = new FallbackController();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Shared block-ref issuer — issues monotonic b<N> IDs for compressed chains;
  // rebuilt from session on session_start / session_tree
  const blockRefs = new BlockRefIssuer();

  // Session-scoped diagnostic sink — tracks recovery-path anomaly counters
  // (dedup'd across the session's lifetime, not per-render).
  const diagnostics = new DiagnosticSink((type, data) => pi.appendEntry(type, data));

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let isFlushing = false;
  let previousFraction: number | null = null;
  // Set on session_start/session_tree when the branch rescan finds recoverable
  // work but pendingBatches was just zeroed (reload/tree-switch). Lets the
  // turn_end budget gate fire without a freshly pushed batch. Boolean only —
  // no queue reconstruction; flushPending's own rescan is the data path.
  // Cleared on every non-concurrent flushPending invocation.
  let rearmedPending = false;

  // Latest ContextMetricsSnapshot, recomputed at reload probes, batch capture,
  // and flush entry. Cached (rather than recomputed on every widget refresh)
  // because computeContextMetrics walks the full branch.
  let metricsCache: ContextMetricsSnapshot | undefined;
  const computeMetricsSnapshot = (ctx: any): ContextMetricsSnapshot | undefined => {
    try {
      // Includes persisted custom_message entries (e.g. this extension's own
      // summary messages) alongside plain "message" entries: both are retained
      // LLM context, so both belong in the largest-chain-share denominator.
      // Projected inline (rather than importing pi-coding-agent's
      // createCustomMessage) because that helper isn't re-exported from the
      // package's "." export map -- shape mirrors createCustomMessage's output
      // (role "custom"), which never matches the user/assistant/toolResult
      // roles computeContextMetrics keys off, so it only inflates totalChars.
      const branch = ctx.sessionManager.getBranch()
        .filter((e: any) => (e.type === "message" && e.message) || e.type === "custom_message")
        .map((e: any) =>
          e.type === "custom_message"
            ? { role: "custom", customType: e.customType, content: e.content, display: e.display, details: e.details, timestamp: new Date(e.timestamp).getTime() }
            : e.message,
        );
      metricsCache = computeContextMetrics(
        branch,
        frontier.get(),
        (k: string) => indexer.isSummarized(k),
        protectionPredicate,
      );
    } catch (err) {
      console.error("pi-condense: context metrics computation failed", err);
    }
    return metricsCache;
  };

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number; dedupedCount?: number }
    | { ok: false; reason: "empty" | "already-flushing" | "summarizer-failed" | "stale-context" | "failed" | "aborted"; error?: string };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedBatch): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    let toolCalls = batch.toolCalls;

    // The indexer tells us what was successfully summarized earlier.
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(occKey(tc.toolCallId, tc.resultTimestamp)));
    if (toolCalls.length === 0) return null;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  // `rethrow` is for the reload rearm probe only (session_start/session_tree):
  // it needs to observe a rescan failure so it can console.error and leave
  // rearmedPending false, per spec. Every other caller (turn_end capture path,
  // flushPending, /pruner commands) keeps the existing swallow-and-fall-back
  // behavior so a transient getBranch failure there never blocks the turn.
  const capturePendingBatches = (ctx: any, opts?: { rethrow?: boolean }): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedBatchesFromSession(branch, indexer, protectionPredicate);
    } catch (err) {
      if (opts?.rethrow) throw err;
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  // Summarizes + indexes all pending batches.
  // When options.onProgress is provided batches are processed sequentially
  // (one LLM call each) so the caller can update per-row UI. Otherwise all
  // batches are summarized in parallel (one summarizeBatches call).
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  // Range-summary fuser injected into compressEligible (B). Returns undefined
  // when fuseRangeSummary is off so the compressor keeps the per-batch concat.
  // Each successful fusion folds its usage + bumps the rangesSummarized counter.
  const makeFuseRange = (ctx: any): ((text: string) => Promise<string | null>) | undefined => {
    if (!currentConfig.value.chainCompression.fuseRangeSummary) return undefined;
    return async (text: string) => {
      const r = await summarizeRange(text, currentConfig.value, ctx, { controller: fallbackController });
      if (r) {
        statsAccum.add(r.usage);
        statsAccum.addRangesSummarized(1);
      }
      return r?.summaryText ?? null;
    };
  };

  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    // Clear on every non-concurrent invocation, regardless of outcome — the
    // rearm is a one-shot nudge for the very next eligible gate check.
    rearmedPending = false;

    // Pre-flush pressure snapshot — recorded once at flush entry so the
    // observability entry reflects what triggered this attempt, not what's
    // left after it ran.
    const entryMetrics: ContextMetricsSnapshot = computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT;
    const trigger: FlushTrigger = options.trigger ?? "manual";
    const delivery = options.delivery ?? "runtime";

    // One-entry-per-attempt tracking, emitted once from the outer `finally`
    // below. `appendEntry` is assigned only once `sessionManager` is captured
    // (session delivery); until then (empty/aborted/pre-capture-failure exits)
    // the emitter falls back to pi.appendEntry.
    let capturedBatches = 0;
    let processedCount = 0;
    let outcome: FlushMetricsEntry["outcome"] = "empty";
    let appendEntry: ((customType: string, data?: unknown) => void) | undefined;

    // Non-fatal by construction: observability must never affect the flush outcome.
    const emitFlushMetricsOnce = () => {
      const entry: FlushMetricsEntry = {
        ts: Date.now(),
        trigger,
        capturedBatches,
        processedBatches: processedCount,
        outcome,
        metrics: entryMetrics,
      };
      const appender: (type: string, data: unknown) => void = appendEntry
        ? delivery === "runtime" ? (type, data) => pi.appendEntry(type, data) : appendEntry
        : (type, data) => pi.appendEntry(type, data);
      try {
        appender(CUSTOM_TYPE_FLUSH_METRICS, entry);
      } catch {
        // non-fatal: observability must never fail the flush
      }
    };

    let batches: CapturedBatch[] = [];
    let sessionManager: SessionAppender | undefined;
    try {
      // Bind the session appender as soon as delivery is known, BEFORE the
      // empty-capture/aborted exits below — so emitFlushMetricsOnce's finally
      // emit routes through sessionManager for those exits too, instead of
      // falling back to the (possibly stale, print-mode) pi.appendEntry.
      if (delivery === "session") {
        try {
          sessionManager = ctx.sessionManager as unknown as SessionAppender;
          appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
        } catch (err) {
          outcome = "error";
          return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
        }
      }

      // Use pre-captured batches if provided (avoids double-capture when the
      // caller previewed the queue before opening the progress overlay).
      batches = options.previewedBatches ?? capturePendingBatches(ctx);
      capturedBatches = batches.length;

      if (batches.length === 0) {
        outcome = "empty";
        return { ok: false, reason: "empty" };
      }

      // Bail out before we drain pendingBatches so they don't need restoring.
      if (options.signal?.aborted) {
        outcome = "error";
        return { ok: false, reason: "aborted" };
      }

      // Draining the queue since we've captured the state via session or slice.
      // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
      // or rapid turn-ends don't result in double-summarization.
      pendingBatches.length = 0;

      isFlushing = true;

      const appendSummaryMessage = (content: string, details: unknown) =>
        sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, false, details);

      // Routes alias persistence through whichever delivery is active so the
      // dedup pre-flush pass writes CUSTOM_TYPE_DEDUP_ALIAS entries via the
      // same path the rest of the flush uses.
      const persistAlias: (customType: string, data?: unknown) => void =
        delivery === "runtime"
          ? (type, data) => pi.appendEntry(type, data)
          : appendEntry!;

      // ── Pre-flush content-hash dedup pass ────────────────────────────
      // For each tool call, check the indexer's contentHashToOriginal map.
      // A hit means an identical (toolName, normalized resultText) pair has
      // already been summarized in an earlier flush. Register the duplicate
      // as an alias of the original (so pruneMessages stub-replaces its
      // ToolResultMessage with the original's short ref) and drop it from
      // the batch BEFORE the summarizer / trivial classifier runs.
      //
      // We track per-batch deduped counts so we can:
      //   - count dedup'd tool calls toward `totalToolCallCount` and
      //     `totalRawCharCount` (they were addressed by this flush even
      //     though no LLM call was made for them),
      //   - tag fully-dedup'd batches with a `"deduped"` ResultSlot so the
      //     existing result loop treats them the same way it treats trivial
      //     batches (advance the frontier without writing a summary).
      const dedupedPerBatch: { toolCalls: import("./src/types.js").CapturedToolCall[]; rawChars: number }[] = batches.map(() => ({ toolCalls: [], rawChars: 0 }));
      const dedupEnabled = currentConfig.value.dedupByContentHash;
      if (dedupEnabled) {
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          const remaining: typeof batch.toolCalls = [];
          for (const tc of batch.toolCalls) {
            const originalId = indexer.lookupByContent(tc.toolName, tc.resultText);
            const key = occKey(tc.toolCallId, tc.resultTimestamp);
            if (originalId && originalId !== key) {
              indexer.registerDuplicate(key, originalId, persistAlias);
              dedupedPerBatch[i].toolCalls.push(tc);
              dedupedPerBatch[i].rawChars += tc.resultText.length;
            } else {
              remaining.push(tc);
            }
          }
          // Shallow-clone the batch so we don't mutate the captured array
          // (pendingBatches consumers retain the original shape on retry).
          batches[i] = { ...batch, toolCalls: remaining };
        }
      }

      // ── Pre-flush trivial filter ─────────────────────────────────
      // Classify each batch by total raw resultText chars BEFORE any LLM call.
      // Batches below minBatchChars are marked trivial: the summarizer is
      // skipped entirely, the frontier still advances, and the original
      // tool-result messages stay verbatim in context. minBatchChars === 0
      // disables the guard (every batch goes to the summarizer).
      //
      // A batch whose entire toolCalls array was just deduped is flagged
      // `isFullyDeduped` so the result loop slots it as "deduped" without
      // confusing it with the trivial path (different outcome + notification).
      const minChars = currentConfig.value.minBatchChars;
      const batchRawChars = batches.map((b) =>
        b.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0),
      );
      const isFullyDeduped = batches.map((b, i) =>
        dedupedPerBatch[i].toolCalls.length > 0 && b.toolCalls.length === 0,
      );
      const isTrivial = batchRawChars.map(
        (c, i) => !isFullyDeduped[i] && minChars > 0 && c < minChars && batches[i].toolCalls.length > 0,
      );
      const nonTrivialIndices: number[] = [];
      for (let i = 0; i < batches.length; i++) {
        if (!isTrivial[i] && !isFullyDeduped[i]) nonTrivialIndices.push(i);
      }

      // Only show "summarizing…" if at least one batch will actually be sent
      // to the LLM. An all-trivial flush is purely bookkeeping.
      if (nonTrivialIndices.length > 0) {
        setPruneStatusWidget(ctx, currentConfig.value, "prune: summarizing…");
      }

      const reportBatchTextProgress = (index: number, total: number, batch: CapturedBatch, receivedChars: number) => {
        options.onBatchTextProgress?.(index, total, batch, receivedChars);
      };

      // Summarize the non-trivial subset. When onProgress is provided
      // (/pruner now overlay) we process sequentially so each row can be
      // checked off as its LLM call completes. Trivial and fully-deduped
      // batches emit a "skipped" progress event immediately, with no
      // spinner / no LLM call. The final `results` array is index-aligned
      // to `batches`, with possible values: SummarizeResult (success),
      // null (LLM failure), "trivial" (pre-flush small-batch skip), or
      // "deduped" (pre-flush dedup ate every tool call in this batch).
      type ResultSlot = import("./src/types.js").SummarizeResult | null | "trivial" | "deduped";
      const results: ResultSlot[] = new Array(batches.length).fill(null);

      if (options.onProgress) {
        for (let i = 0; i < batches.length; i++) {
          if (isFullyDeduped[i]) {
            options.onProgress(i, batches.length, batches[i], "skipped");
            results[i] = "deduped";
            continue;
          }
          if (isTrivial[i]) {
            options.onProgress(i, batches.length, batches[i], "skipped");
            results[i] = "trivial";
            continue;
          }
          options.onProgress(i, batches.length, batches[i], "start");
          const r = await summarizeBatch(batches[i], currentConfig.value, ctx, {
            signal: options.signal,
            controller: fallbackController,
            onTextProgress: (receivedChars) => {
              reportBatchTextProgress(i, batches.length, batches[i], receivedChars);
            },
          });
          results[i] = r;
          options.onProgress(i, batches.length, batches[i], r ? "done" : "skipped");
        }
      } else {
        // Mark all trivial + fully-deduped slots up front, then call
        // summarizeBatches with only the remaining batches (parallel — one
        // LLM call each).
        for (let i = 0; i < batches.length; i++) {
          if (isFullyDeduped[i]) results[i] = "deduped";
          else if (isTrivial[i]) results[i] = "trivial";
        }
        if (nonTrivialIndices.length > 0) {
          const nonTrivialBatches = nonTrivialIndices.map((i) => batches[i]);
          const ntResults = await summarizeBatches(nonTrivialBatches, currentConfig.value, ctx, {
            onBatchTextProgress: (ntIndex, _ntTotal, batch, receivedChars) => {
              const origIndex = nonTrivialIndices[ntIndex];
              reportBatchTextProgress(origIndex, batches.length, batch, receivedChars);
            },
            signal: options.signal,
            controller: fallbackController,
          });
          for (let k = 0; k < nonTrivialIndices.length; k++) {
            results[nonTrivialIndices[k]] = ntResults[k];
          }
        }
      }

      // Process results in order; stop at first null (individual call failure).
      // Batches before the first failure are persisted; remaining are restored to
      // pendingBatches so they are retried on the next flush.
      const processedBatches: CapturedBatch[] = [];
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalToolCallCount = 0;
      let totalDedupedCount = 0;
      const oversizedBatches: CapturedBatch[] = [];
      const trivialBatches: CapturedBatch[] = [];
      const dedupedBatches: CapturedBatch[] = [];
      let firstFailureIndex = -1;

      for (let i = 0; i < batches.length; i++) {
        const result = results[i];
        if (result === null) {
          firstFailureIndex = i;
          break;
        }

        const batch = batches[i];
        const batchRawCharCount = batchRawChars[i];
        const dedupCount = dedupedPerBatch[i].toolCalls.length;
        const dedupRawChars = dedupedPerBatch[i].rawChars;

        // Fully-deduped batches: every tool call matched an existing
        // indexed record. The alias entries are already persisted; we just
        // need to advance the frontier past this turn and count the
        // dedup'd raw chars toward the flush totals so the user sees the
        // savings.
        if (result === "deduped") {
          totalRawCharCount += dedupRawChars;
          totalToolCallCount += dedupCount;
          totalDedupedCount += dedupCount;
          dedupedBatches.push(batch);
          processedBatches.push(batch);
          continue;
        }

        // Trivial batches: no summary text, no index entry, no stats usage —
        // just bookkeeping so the frontier can advance past this range and
        // the next flush does not reconsider these tool calls.
        if (result === "trivial") {
          // Count dedup'd tool calls (if any) on a partial-dedup batch even
          // though the rest of the batch was below minBatchChars.
          totalRawCharCount += batchRawCharCount + dedupRawChars;
          totalToolCallCount += batch.toolCalls.length + dedupCount;
          totalDedupedCount += dedupCount;
          trivialBatches.push(batch);
          processedBatches.push(batch);
          continue;
        }

        const summaryRefs = indexer.allocateSummaryRefs(batch);
        const toolNames = batch.toolCalls.map((tc) => tc.toolName);
        const decorated = substituteInlineRefs(result.summaryText, summaryRefs, toolNames);
        const summaryText = decorated + formatSummaryToolCallRefs(summaryRefs);
        const shouldSkipOversized = summaryText.length > batchRawCharCount;

        statsAccum.add(result.usage);
        totalRawCharCount += batchRawCharCount + dedupRawChars;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length + dedupCount;
        totalDedupedCount += dedupCount;

        const batchDetails = makeSummaryDetails(batch, summaryRefs);

        try {
          if (!shouldSkipOversized) {
            // Write one hidden summary message per turn and index its tool calls.
            // `display: false` keeps the summary in future LLM context (convertToLlm
            // ignores `display`) while suppressing the full markdown block from Pi's
            // main window; rebuild keys on customType, not display.
            const batchOccurrenceKeys = batch.toolCalls.map((tc) => occKey(tc.toolCallId, tc.resultTimestamp));
            if (delivery === "runtime") {
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails },
                { deliverAs: "steer" }
              );
              indexer.registerSummaryRefs(summaryRefs);
              indexer.addBatch(batch, (type, data) => pi.appendEntry(type, data));
            } else {
              appendSummaryMessage(summaryText, batchDetails);
              indexer.registerSummaryRefs(summaryRefs);
              indexer.addBatch(batch, appendEntry!);
            }
            // Keep the in-memory summary-body registry current so chain compression
            // can build synthetic chain messages without rescanning session entries.
            indexer.registerSummaryBody(batchOccurrenceKeys, summaryText);
          } else {
            oversizedBatches.push(batch);
          }
        } catch (err) {
          // Persistence error mid-loop: stop here, restore this and remaining batches.
          if (isStaleContextError(err)) {
            restoreBatches(batches.slice(i));
            // Advance frontier to what we managed to persist before this point
            break;
          }
          throw err;
        }

        processedBatches.push(batch);
      }

      // Restore unprocessed batches (those at and after the first failure)
      if (firstFailureIndex >= 0) {
        restoreBatches(batches.slice(firstFailureIndex));
      }

      if (processedBatches.length === 0) {
        // Nothing was persisted (all calls failed or first call failed)
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);
        outcome = "error";
        return { ok: false, reason: "summarizer-failed" };
      }

      // Advance frontier to the last batch we actually processed. A fully
      // deduped batch has `toolCalls === []` (the dedup pass shallow-cloned
      // the batch with only the remaining non-dup calls). In that case, fall
      // back to the matching `dedupedPerBatch[i].toolCalls` so the frontier
      // anchor still points at a real tool call — otherwise we'd dereference
      // `undefined.toolCallId` and the whole flush would throw, silently
      // dropping the dedup-alias write's effect on subsequent flushes.
      const lastBatch = processedBatches[processedBatches.length - 1];
      const lastBatchOrigIndex = batches.indexOf(lastBatch);
      const lastBatchAllTCs =
        lastBatch.toolCalls.length > 0
          ? lastBatch.toolCalls
          : (lastBatchOrigIndex >= 0 ? dedupedPerBatch[lastBatchOrigIndex].toolCalls : []);
      const lastTC = lastBatchAllTCs[lastBatchAllTCs.length - 1];

      // Outcome precedence: any actual summary wins; oversized beats deduped
      // beats trivial. (Trivial and deduped are both zero-LLM-cost; deduped
      // is the more interesting signal because it implies the indexer caught
      // a redundancy, so it wins the tiebreaker.)
      const actuallyFlushedCount =
        processedBatches.length - trivialBatches.length - oversizedBatches.length - dedupedBatches.length;
      const flushOutcome: PruneFrontier["outcome"] =
        actuallyFlushedCount > 0
          ? "summarized"
          : oversizedBatches.length > 0
            ? "skipped-oversized"
            : dedupedBatches.length > 0
              ? "skipped-deduped"
              : "skipped-trivial";

      // Raw session branch, unwrapped once for the chain-compression block below.
      // Only materialized when chain compression is enabled.
      let branchMessages: any[] | undefined;
      if (currentConfig.value.chainCompression.enabled) {
        branchMessages = ctx.sessionManager.getBranch()
          .filter((e: any) => e.type === "message" && e.message)
          .map((e: any) => e.message);
      }

      const frontierSnapshot: PruneFrontier = {
        lastAttemptedToolCallId: lastTC.toolCallId,
        lastAttemptedToolName: lastTC.toolName,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: processedBatches.length,
        attemptedToolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: flushOutcome,
      };

      try {
        if (delivery === "runtime") {
          frontier.advance(frontierSnapshot);
          frontier.persist(pi);
          statsAccum.persist(pi);
        } else {
          frontier.advance(frontierSnapshot);
          appendEntry!(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          try {
            appendEntry!(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
        }
      } catch (err) {
        // Batches were summarized/persisted before the frontier/stats write failed;
        // reflect that in processedBatches rather than reporting 0.
        processedCount = processedBatches.length;
        outcome = "error";
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);
      emitExternalCost(pi, statsAccum);

      // Chain compression — compress closed chains beyond the rolling window.
      // Runs after the per-batch summarization so summaryBodies are up to date.
      // Non-fatal: a failure here does not roll back the successful summarization.
      if (currentConfig.value.chainCompression.enabled) {
        try {
          // message_end fires before pi persists the closing assistant, so thread it
          // in here; otherwise the newest chain reads as open and K over-retains by 1.
          // branchMessages was unwrapped once above, gated on chainCompression.enabled.
          const detectionMessages = withClosingMessage(branchMessages!, options.closingMessage);
          const chains = detectChains(detectionMessages, protectionPredicate);
          const inGrace = inGraceRecoveryToolCallIds(branchMessages!, currentConfig.value.recoveryGraceTurns);
          const { compressedEntries } = await compressEligible(
            chains,
            currentConfig.value.chainCompression.rollingWindow,
            {
              indexer,
              blockRefs,
              appendEntry: persistAlias,
              now: () => Date.now(),
              fuseRange: makeFuseRange(ctx),
              messages: detectionMessages,
              diagnostics,
              backfill: {
                spillThreshold: currentConfig.value.spillThreshold,
                spillPreviewBytes: currentConfig.value.spillPreviewBytes,
                sessionDir: ctx.sessionManager.getSessionDir(),
                sessionId: ctx.sessionManager.getSessionId(),
              },
            },
            inGrace,
          );
          if (compressedEntries.length > 0) {
            statsAccum.addChainsCompressed(compressedEntries.length);
            statsAccum.persist(pi);
            emitExternalCost(pi, statsAccum);
            safeNotify(
              ctx,
              `pruner: compressed ${compressedEntries.length} chain${compressedEntries.length === 1 ? "" : "s"} (${compressedEntries.map((e) => e.blockId).join(", ")})`,
              "info",
            );
          }
        } catch (err) {
          if (!isStaleContextError(err)) {
            safeNotify(ctx, `pruner: chain compression failed: ${errorMessage(err)}`, "warning");
          }
        }
      }

      // Notify about any batches that were skipped — either oversized or
      // trivial. Neither is an error: the pruner correctly chose not to grow
      // context (oversized) or to skip the LLM call entirely (trivial). Both
      // are silenced by `quietOversizedSkips`, which acts as a single
      // "quiet all non-error skips" toggle.
      if (!currentConfig.value.quietOversizedSkips) {
        for (const batch of oversizedBatches) {
          const batchRaw = batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
          const slot = results[batches.indexOf(batch)];
          const batchSummaryLen = slot && slot !== "trivial" && slot !== "deduped" ? slot.summaryText.length : 0;
          safeNotify(
            ctx,
            `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${batchRaw} raw chars; frontier advanced past this range`,
            "info"
          );
        }
        for (const batch of trivialBatches) {
          const batchRaw = batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
          safeNotify(
            ctx,
            `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — only ${batchRaw} raw chars (< minBatchChars=${minChars}); no LLM call made; frontier advanced past this range`,
            "info"
          );
        }
        for (const batch of dedupedBatches) {
          const idx = batches.indexOf(batch);
          const n = dedupedPerBatch[idx].toolCalls.length;
          const chars = dedupedPerBatch[idx].rawChars;
          safeNotify(
            ctx,
            `pruner: deduplicated ${n} tool call${n === 1 ? "" : "s"} (turn ${batch.turnIndex}, ${chars} raw chars) against earlier prunes; no LLM call made; frontier advanced past this range`,
            "info"
          );
        }
        if (totalDedupedCount > 0 && dedupedBatches.length === 0) {
          // Partial-dedup case: some tool calls were dedup'd but the rest
          // of the batch went through the summarizer. Surface a single
          // aggregate notification so users see the savings.
          safeNotify(
            ctx,
            `pruner: deduplicated ${totalDedupedCount} tool call${totalDedupedCount === 1 ? "" : "s"} against earlier prunes (no LLM call for those); remaining tool calls were summarized normally.`,
            "info"
          );
        }
      }

      // Very end of the try block, deliberately after (and outside) the
      // chain-compression block's own try/catch above: a compression failure
      // must not eat this entry — the summarization phase already succeeded.
      processedCount = processedBatches.length;
      outcome = flushOutcome;

      const returnReason: "flushed" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped" =
        actuallyFlushedCount > 0
          ? "flushed"
          : oversizedBatches.length > 0
            ? "skipped-oversized"
            : dedupedBatches.length > 0
              ? "skipped-deduped"
              : "skipped-trivial";

      return {
        ok: true,
        reason: returnReason,
        batchCount: processedBatches.length,
        toolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        dedupedCount: totalDedupedCount,
      };
    } catch (err) {
      restoreBatches(batches);
      outcome = "error";
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
      emitFlushMetricsOnce();
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from <agent-dir>/settings.json `contextPrune` key (honors PI_CODING_AGENT_DIR)
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild block-ref counter so new chain IDs don't collide with existing ones
    blockRefs.rebuildFrom(indexer.getChainEntries().map((e) => e.blockId));

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);
    fallbackController.reset();
    diagnostics.reset();

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;
    previousFraction = null;
    rearmedPending = false;
    if (currentConfig.value.enabled) {
      try {
        rearmedPending = capturePendingBatches(ctx, { rethrow: true }).length > 0;
      } catch (err) {
        console.error("pi-condense: reload rearm probe failed", err);
      }
    }

    computeMetricsSnapshot(ctx);

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);

    ctx.ui.setWidget(
      "pruner-boot",
      [
        `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      ],
      { placement: "belowEditor" },
    );
    setTimeout(() => {
      try {
        ctx.ui.setWidget("pruner-boot", undefined);
      } catch {
        // UI owner may be gone after session replacement.
      }
    }, 10000).unref?.();
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    blockRefs.rebuildFrom(indexer.getChainEntries().map((e) => e.blockId));
    statsAccum.reconstructFromSession(ctx);
    diagnostics.reset();
    frontier.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
    previousFraction = null;
    rearmedPending = false;
    if (currentConfig.value.enabled) {
      try {
        rearmedPending = capturePendingBatches(ctx, { rethrow: true }).length > 0;
      } catch (err) {
        console.error("pi-condense: reload rearm probe failed", err);
      }
    }

    computeMetricsSnapshot(ctx);
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    // Text-only final turns are handled by message_end in agent-message mode.
    // In print mode, turn_end can fire after session shutdown, so do not start
    // deferred LLM work from this late lifecycle event — UNLESS a reload probe
    // (session_start/session_tree) found recoverable pending work: that flag
    // must still reach the budget/delta gate below without a freshly captured
    // batch on this turn.
    if (!hasToolResults && !rearmedPending) return;

    let pushedBatch = false;
    if (hasToolResults) {
      const capturedBatch = captureBatch(
        event.message,
        event.toolResults,
        event.turnIndex,
        Date.now()
      );
      // Drop user-protected tool/path results so they stay verbatim in context.
      // Filtering at capture time keeps the
      // underlying assistant `toolCall` block AND its `ToolResultMessage`
      // untouched in Pi's session/event stream — only the in-memory
      // CapturedBatch is pruned, which is exactly what we want.
      const filtered = {
        ...capturedBatch,
        toolCalls: capturedBatch.toolCalls.filter((tc) => !isProtected(tc.toolName, tc.args, currentConfig.value)),
      };

      // Eager spill: offload oversized single results to sidecar files before they
      // ever reach a request. addBatch inside marks them isSummarized, so
      // trimBatchToPendingRange drops them from the pending set below. Best-effort:
      // a spill failure leaves the result inline for the normal flush pipeline.
      try {
        await spillOversizedBatch({
          batch: filtered,
          indexer,
          config: {
            spillThreshold: currentConfig.value.spillThreshold,
            spillPreviewBytes: currentConfig.value.spillPreviewBytes,
            dedupByContentHash: currentConfig.value.dedupByContentHash,
          },
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: ctx.sessionManager.getSessionId(),
          appendEntry: (type, data) => (ctx.sessionManager as unknown as SessionAppender).appendCustomEntry(type, data),
        });
      } catch {
        // best-effort; never block the turn
      }

      const batch = trimBatchToPendingRange(filtered);
      if (batch) {
        pushedBatch = true;
        pendingBatches.push(batch);

        // Let the user know a batch is queued
        const n = pendingBatches.length;
        const trigger = currentConfig.value.pruneOn === "agent-message"
          ? "agent's next text response"
          : "/pruner now";
        if (currentConfig.value.showPruneStatusLine) {
          setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
          safeNotify(
            ctx,
            `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
            "info"
          );
        }
      }
    }

    // Recompute regardless of whether trim produced a batch: a turn whose
    // toolResults are all protected/spilled/summarized/trimmed-empty still
    // changes the branch (thinking, open-segment size), so the cache must not
    // go stale on it. Placed before the pushedBatch/rearmedPending early
    // return below — a cache write is not gate evaluation.
    if (hasToolResults) computeMetricsSnapshot(ctx);

    // Mirrors main's `if (!batch) return;`: no freshly pushed batch this turn
    // means no gate evaluation, regardless of leftover pendingBatches from an
    // earlier turn — UNLESS a reload probe armed rearmedPending, in which case
    // the gate below must still run.
    if (!pushedBatch && !rearmedPending) return;

    // Token-budget auto-flush: an additional, mode-independent trigger. When context
    // usage crosses autoBudgetThreshold, compact the queued batches now instead of
    // waiting for this mode's flush boundary. The pendingBatches.length-or-rearmed
    // guard makes an already-drained, non-rearmed queue a no-op.
    const usage = ctx.getContextUsage?.();
    const budgetHit = shouldBudgetFlush(usage, currentConfig.value.autoBudgetThreshold);
    const deltaHit = shouldDeltaFlush(usage, previousFraction, currentConfig.value.budgetTurnDelta);
    // Update the per-turn baseline; leave it unchanged when tokens is null (e.g.
    // right after a compaction) so the next real reading compares to the last known.
    const f = usageFraction(usage);
    if (f != null) previousFraction = f;

    const n = pendingBatches.length;
    if ((n > 0 || rearmedPending) && !isFlushing && (budgetHit || deltaHit)) {
      // Always surface this flush (even when the routine status line is off): it's a
      // significant, infrequent event — context crossed a threshold or jumped sharply
      // this turn — and it self-throttles because pendingBatches is drained right after.
      safeNotify(
        ctx,
        n > 0
          ? `pruner: ${budgetHit ? "context budget reached" : "context jumped this turn"} — compacting ${n} pending turn${n === 1 ? "" : "s"}`
          : `pruner: ${budgetHit ? "context budget reached" : "context jumped this turn"} — compacting work recovered after reload`,
        "info",
      );
      await flushPending(ctx, { delivery: "session", trigger: n === 0 ? "rearmed" : budgetHit ? "budget" : "delta" });
    }
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    await flushPending(ctx, { delivery: "session", closingMessage: event.message, trigger: "message-end" });
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0 && !rearmedPending) return;
    setPruneStatusWidget(
      ctx,
      currentConfig.value,
      pendingBatches.length > 0 ? `prune: ${pendingBatches.length} pending` : "prune: recovered pending (reload)",
    );
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, ctx) => {
    if (!currentConfig.value.enabled) return undefined;

    let messages = event.messages;
    let changed = false;

    // pruneMessages is the single source of truth for "is there work to do".
    // It returns the original array reference (pruned: false) only when none of
    // the four phases changed anything; index/registry emptiness alone does not
    // imply a no-op, since error-purge (phase 2) prunes independently of them.
    // Calling it unconditionally is safe and avoids a split gate here.
    const result = pruneMessages(
      messages,
      indexer,
      currentConfig.value.chainCompression,
      currentConfig.value.purgeErrors,
      currentConfig.value,
      currentConfig.value.recoveryGraceTurns,
      diagnostics,
    );
    if (result.pruned) {
      messages = result.messages;
      changed = true;
      statsAccum.setLiveReclaim(result.beforeChars, result.afterChars);
    }
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getLiveReclaim(), diagnostics.counts(), metricsCache);

    if (!changed) return undefined;
    return { messages };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register /pruner command + summary message renderer ────────────
  const compactChains = async (ctx: any) => {
    const branch = ctx.sessionManager.getBranch();
    const branchMessages = branch
      .filter((e: any) => e.type === "message" && e.message)
      .map((e: any) => e.message);
    const chains = detectChains(branchMessages, protectionPredicate);
    const inGrace = inGraceRecoveryToolCallIds(branchMessages, currentConfig.value.recoveryGraceTurns);
    const result = await compressEligible(
      chains,
      0, // effectiveK=0: compress every closed chain not already compressed
      {
        indexer,
        blockRefs,
        appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data),
        now: () => Date.now(),
        fuseRange: makeFuseRange(ctx),
        messages: branchMessages,
        diagnostics,
        backfill: {
          spillThreshold: currentConfig.value.spillThreshold,
          spillPreviewBytes: currentConfig.value.spillPreviewBytes,
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: ctx.sessionManager.getSessionId(),
        },
      },
      inGrace,
    );
    if (result.compressedEntries.length > 0) {
      statsAccum.addChainsCompressed(result.compressedEntries.length);
      statsAccum.persist(pi);
      emitExternalCost(pi, statsAccum);
    }
    return { compressedEntries: result.compressedEntries, skipped: result.skipped.filter((s) => s.reason === "no-summary").length };
  };

  registerCommands(
    pi,
    currentConfig,
    flushPending,
    capturePendingBatches,
    () => statsAccum.getStats(),
    () => statsAccum.getLiveReclaim(),
    indexer,
    compactChains,
    () => diagnostics.counts(),
    (ctx: any) => computeMetricsSnapshot(ctx) ?? EMPTY_METRICS_SNAPSHOT,
    () => metricsCache,
    () => rearmedPending,
  );
}
