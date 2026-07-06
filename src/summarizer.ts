import { stream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";
import { FallbackController, type FallbackTransition } from "./summarizer-fallback.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome, plus any file paths, identifiers, signatures, or error strings copied verbatim - never reword these
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Skip calls that succeeded with nothing reusable to record. Be concise.

Begin the first bullet of each tool call with that tool's [[N:toolname]] label, copied verbatim (both the number and the name) from its line in the input, as the plain, first thing on the line - no bold, backticks, or list numbering around it. Do not renumber, rename, or invent labels; if you skip a tool, skip its label too.`;

const RANGE_SYSTEM_PROMPT = `You are fusing several per-step summaries of one CLOSED sub-task from an AI coding assistant's history into a SINGLE cohesive summary.
- Merge overlapping or repeated information; do not restate each step separately.
- Preserve concrete outcomes, decisions, file paths, identifiers, and anything later work needs to remember.
- Keep any reference tokens like \`t12\` or \`b3\` intact.
- Be concise: a short narrative or a few grouped bullets, not one bullet per step.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/** A summary is usable only if it has non-whitespace text and was not truncated. */
export function isUsableSummary(llmText: string, stopReason: string): boolean {
  return llmText.trim().length > 0 && stopReason !== "length";
}

type RunOutcome =
  | { kind: "ok"; result: SummarizeResult }
  | { kind: "auth"; message: string }
  | { kind: "unusable" }
  | { kind: "transient"; message: string };

/** Human label for a model in notify text: prefer name, fall back to provider/id. */
function modelLabel(model: any): string {
  if (!model) return "unknown model";
  return model.name || `${model.provider}/${model.id}`;
}

/**
 * One summarization attempt against a specific model. Returns a classified
 * outcome instead of throwing (except aborts, which propagate so flushPending
 * can restore state). Auth failure is detected pre-stream and never reaches
 * the fallback path. `unusable` = empty or length-truncated. Everything else
 * that reaches the catch is `transient` (the outage bucket) — pi-ai surfaces
 * no structured status code on the throw, so classification is coarse by design.
 */
async function runOnce(
  model: any,
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<RunOutcome> {
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      return { kind: "auth", message: authMessage };
    }

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const responseStream = stream(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) }
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarize: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so the catch below can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarize: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      return { kind: "transient", message: response.errorMessage ?? "Summarizer stopped with reason: error" };
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    if (!isUsableSummary(llmText, response.stopReason)) return { kind: "unusable" };

    return { kind: "ok", result: { summaryText: llmText, usage: response.usage } };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    return { kind: "transient", message: err.message };
  }
}

/**
 * Shared LLM-call machinery for both per-batch and range summarization.
 * `userMessage` already embeds the relevant system prompt as leading text
 * (the summarizer is a single-user-message call). Returns the formatted text
 * + usage, or null on failure. Abort errors are re-thrown so flushPending can
 * detect options.signal.aborted and restore state without a UI error.
 *
 * When options.controller is set AND a distinct fallback model exists, a
 * transient failure of the configured summarizer model is retried once on the
 * session model, and the controller stays sticky in fallback until a
 * per-cooldown probe of the primary succeeds.
 */
async function runSummarization(
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarize: aborted before start");

  const primary = resolveModel(config, ctx);
  const controller = options.controller;
  const sessionModel = ctx.model;

  const notifyError = (msg: string) =>
    ctx.ui.notify(`pruner: summarization failed: ${msg}`, "error");

  // No controller or no distinct fallback: single attempt, legacy behavior.
  if (!controller || !FallbackController.hasDistinctFallback(primary, sessionModel)) {
    const r = await runOnce(primary, userMessage, config, ctx, options);
    switch (r.kind) {
      case "ok":
        return r.result;
      case "auth":
      case "transient":
        notifyError(r.message);
        return null;
      case "unusable":
        return null;
    }
  }

  const emit = (t: FallbackTransition) => {
    if (t === "enter") {
      ctx.ui.notify(
        `pi-condense: summarizer model ${modelLabel(primary)} failing, using session model ${modelLabel(sessionModel)} until it recovers`,
        "warning"
      );
    } else if (t === "recover") {
      ctx.ui.notify(`pi-condense: summarizer model ${modelLabel(primary)} recovered`, "info");
    }
  };

  const decision = controller.chooseTarget();
  const model = decision.target === "primary" ? primary : sessionModel;
  const r = await runOnce(model, userMessage, config, ctx, options);

  switch (r.kind) {
    case "ok":
      if (decision.target === "primary") emit(controller.onPrimarySuccess(decision.wasProbe));
      else emit(controller.onFallbackSuccess());
      return r.result;
    case "auth":
      notifyError(r.message); // auth never trips the controller
      return null;
    case "unusable":
      return null; // probe unusable => stay (no state change)
    case "transient": {
      if (decision.target === "fallback") {
        controller.onFallbackOnlyFail();
        notifyError(r.message);
        return null;
      }
      // target was primary (initial detection or probe): retry once on the session model.
      const r2 = await runOnce(sessionModel, userMessage, config, ctx, options);
      if (r2.kind === "ok") {
        emit(controller.onPrimaryFailFallbackOk(decision.wasProbe));
        return r2.result; // suppress the legacy error notify — fallback rescued the call
      }
      controller.onBothDown();
      notifyError(r2.kind === "transient" || r2.kind === "auth" ? r2.message : r.message);
      return null;
    }
  }
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  const serialized = serializeBatchForSummarizer(batch);
  const userMessage =
    SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Fuses a closed chain's already-computed per-batch summaries into one cohesive
 * range summary (recursive summarization). Input is the span's per-batch summary
 * text — small and already pruned — so this never re-sends raw tool output.
 * Returns the fused text + usage, or null on failure. Used by chain compression
 * to replace the concatenated per-batch body with a single coherent summary.
 */
export async function summarizeRange(
  perBatchSummaryText: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  const userMessage =
    RANGE_SYSTEM_PROMPT + "\n\n<sub-task-summaries>\n" + perBatchSummaryText + "\n</sub-task-summaries>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        controller: options.controller,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        controller: options.controller,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  );
}
