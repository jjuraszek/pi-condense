/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save <agent-dir>/settings.json `contextPrune` namespace (honors PI_CODING_AGENT_DIR)
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode } from "./src/batch-capture.js";
import { summarizeBatch, summarizeBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { annotateWithUnprunedCount, countUnprunedToolCalls } from "./src/reminder.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { formatSummaryToolCallRefs, makeSummaryDetails } from "./src/summary-refs.js";
import type { ContextPruneConfig, CapturedBatch, PruneFrontier, FlushOptions } from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CONTEXT_PRUNE_TOOL_NAME,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let isFlushing = false;

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
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(tc.toolCallId));
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
  const capturePendingBatches = (ctx: any): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedBatchesFromSession(branch, indexer, [
        CONTEXT_PRUNE_TOOL_NAME,
        ...currentConfig.value.protectedTools,
      ]);
    } catch {
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
  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    // Use pre-captured batches if provided (avoids double-capture when the
    // caller previewed the queue before opening the progress overlay).
    let batches: CapturedBatch[] = options.previewedBatches ?? capturePendingBatches(ctx);

    if (batches.length === 0) return { ok: false, reason: "empty" };

    // Bail out before we drain pendingBatches so they don't need restoring.
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    // Draining the queue since we've captured the state via session or slice.
    // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
    // or rapid turn-ends don't result in double-summarization.
    pendingBatches.length = 0;

    isFlushing = true;

    const delivery = options.delivery ?? "runtime";
    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
    }

    const appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, true, details);

    // Routes alias persistence through whichever delivery is active so the
    // dedup pre-flush pass writes CUSTOM_TYPE_DEDUP_ALIAS entries via the
    // same path the rest of the flush uses.
    const persistAlias: (customType: string, data?: unknown) => void =
      delivery === "runtime"
        ? (type, data) => pi.appendEntry(type, data)
        : appendEntry;

    try {
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
            if (originalId && originalId !== tc.toolCallId) {
              indexer.registerDuplicate(tc.toolCallId, originalId, persistAlias);
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
        const summaryText = result.summaryText + formatSummaryToolCallRefs(summaryRefs);
        const shouldSkipOversized = summaryText.length > batchRawCharCount;

        statsAccum.add(result.usage);
        totalRawCharCount += batchRawCharCount + dedupRawChars;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length + dedupCount;
        totalDedupedCount += dedupCount;

        const batchDetails = makeSummaryDetails(batch, summaryRefs);

        try {
          if (!shouldSkipOversized) {
            // Write one summary message per turn and index its tool calls.
            if (delivery === "runtime") {
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: true, details: batchDetails },
                { deliverAs: "steer" }
              );
              indexer.registerSummaryRefs(summaryRefs);
              indexer.addBatch(batch, (type, data) => pi.appendEntry(type, data));
            } else {
              appendSummaryMessage(summaryText, batchDetails);
              indexer.registerSummaryRefs(summaryRefs);
              indexer.addBatch(batch, appendEntry);
            }
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
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
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
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
        }
      } catch (err) {
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

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
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from <agent-dir>/settings.json `contextPrune` key (honors PI_CODING_AGENT_DIR)
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by message_end in agent-message mode.
      // In print mode, turn_end can fire after session shutdown, so do not start
      // deferred LLM work from this late lifecycle event.
      return;
    }

    const capturedBatch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    // Drop housekeeping (context_prune) and any user-protected tool results so
    // they stay verbatim in context. Filtering at capture time keeps the
    // underlying assistant `toolCall` block AND its `ToolResultMessage`
    // untouched in Pi's session/event stream — only the in-memory
    // CapturedBatch is pruned, which is exactly what we want.
    const protectedToolSet = new Set<string>([
      CONTEXT_PRUNE_TOOL_NAME,
      ...currentConfig.value.protectedTools,
    ]);
    const batch = trimBatchToPendingRange({
      ...capturedBatch,
      toolCalls: capturedBatch.toolCalls.filter((tc) => !protectedToolSet.has(tc.toolName)),
    });
    if (!batch) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_tag / context_checkpoint";
          break;
        case "agent-message":
          trigger = "agent's next text response";
          break;
        case "agentic-auto":
          trigger = "agent calling context_prune";
          break;
        default:
          trigger = "/pruner now";
          break;
      }
      if (currentConfig.value.showPruneStatusLine) {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
        safeNotify(
          ctx,
          `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
          "info"
        );
      }
    }
  });

  // ── tool_execution_end: flush when context_tag / context_checkpoint fires ─
  // `context_tag` is the legacy tool name from older versions of ttttmr/pi-context;
  // the current upstream renamed it to `context_checkpoint`. Accept both so users
  // on either version trigger the on-context-tag flush. The mode value itself stays
  // `on-context-tag` for backward compatibility with persisted configs.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag" && event.toolName !== "context_checkpoint") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, { delivery: "runtime" });
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
    await flushPending(ctx, { delivery: "session" });
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    setPruneStatusWidget(ctx, currentConfig.value, `prune: ${pendingBatches.length} pending`);
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;

    const indexEmpty = indexer.getIndex().size === 0;
    let messages = event.messages;
    let changed = false;

    if (!indexEmpty) {
      const result = pruneMessages(messages, indexer);
      if (result.pruned) {
        messages = result.messages;
        changed = true;
      }
    }

    // Append a small `<pruner-note>` to the last toolResult telling the model
    // how many unpruned tool calls are sitting in context. Only active in
    // agentic-auto mode (where the LLM itself decides when to call
    // context_prune) and only when the user has the reminder enabled.
    if (
      currentConfig.value.pruneOn === "agentic-auto" &&
      currentConfig.value.remindUnprunedCount
    ) {
      const count = countUnprunedToolCalls(messages, indexer, currentConfig.value.protectedTools);
      if (count > 0) {
        const annotated = annotateWithUnprunedCount(messages, count);
        if (annotated !== messages) {
          messages = annotated;
          changed = true;
        }
      }
    }

    if (!changed) return undefined;
    return { messages };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, (ctx, options) => flushPending(ctx, { delivery: "runtime", ...options }));

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending, capturePendingBatches, syncToolActivation, () => statsAccum.getStats(), indexer);
}
