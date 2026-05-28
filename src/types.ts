/**
 * Shared types for the context-prune extension.
 *
 * Design decisions (Phase 1):
 *
 * SUMMARIZATION BATCH (Ph1 step 2):
 *   One batch = one completed assistant turn with tool calls, captured from
 *   the `turn_end` event when event.toolResults.length > 0.
 *   event.message = AssistantMessage (contains ToolCall content blocks with ids)
 *   event.toolResults = ToolResultMessage[] (one per tool call in this turn)
 *
 * STATE MODEL (Ph1 step 3):
 *   - Runtime state: Map<toolCallId, ToolCallRecord> rebuilt on session_start
 *   - Session metadata: pi.appendEntry("context-prune-index", IndexEntryData)
 *     stored once per summarized batch; NOT in LLM context
 *   - User config: .pi/settings.json → "contextPrune" key (JSON merge safe,
 *     Pi preserves unknown keys when rewriting settings files)
 *
 * CONFIG FORMAT (Ph1 step 4):
 *   { "contextPrune": { "enabled": false, "summarizerModel": "default", "showPruneStatusLine": true } }
 *   summarizerModel: "default" = use current active model (ctx.model)
 *                   "provider/model-id" = explicit model via ctx.modelRegistry.find()
 *
 * SUMMARY MESSAGE FORMAT (Ph1 step 5):
 *   customType: "context-prune-summary"
 *   content: markdown with one bullet per tool call + short-id footer
 *   details: SummaryMessageDetails (toolCallRefs, toolNames, turnIndex, timestamp)
 *   The content itself includes short alias IDs in plain text so the model can
 *   reference them in future context_tree_query calls without needing details.
 *
 * API CONSTRAINTS (Ph1 step 6):
 *   - Pruning MUST happen in the `context` event via { messages: filtered },
 *     never by mutating session history (pi.appendEntry / session file untouched)
 *   - Summary injection uses pi.sendMessage(..., { deliverAs: "steer" }) from
 *     inside the turn_end handler so it lands before the next LLM call
 *   - Original full tool outputs are preserved in IndexEntryData (session custom
 *     entries) and accessible via context_tree_query at any time
 *   - v1 prunes only ToolResultMessage entries; the AssistantMessage tool-call
 *     blocks (which carry the toolCallIds) are intentionally kept so the model
 *     can still reference them when calling context_tree_query
 *   - "default" summarizer = ctx.model (current active model + its credentials),
 *     NOT a hidden side-channel. It makes an explicit LLM call from turn_end.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** customType for summary custom_message entries (appear in LLM context) */
export const CUSTOM_TYPE_SUMMARY = "context-prune-summary";

/** customType for index persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_INDEX = "context-prune-index";

/** customType for stats persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_STATS = "context-prune-stats";

/** customType for prune-frontier persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_FRONTIER = "context-prune-frontier";

/**
 * customType for content-hash dedup alias entries (NOT in LLM context).
 *
 * One entry per duplicate tool call detected by the pre-flush dedup pass.
 * The new toolCallId is registered as an alias of an already-indexed
 * original toolCallId. The original's record (in CUSTOM_TYPE_INDEX) is
 * the source of truth for the result text. See
 * src/content-hash.ts and src/indexer.ts for the dedup machinery.
 */
export const CUSTOM_TYPE_DEDUP_ALIAS = "context-prune-dedup-alias";

/** Footer status widget ID */
export const STATUS_WIDGET_ID = "context-prune";

/**
 * Widget ID for the live /pruner now progress panel shown above the editor.
 */
export const PROGRESS_WIDGET_ID = "context-prune-progress";

/** Name of the context_prune tool (injected only when agentic-auto mode is active) */
export const CONTEXT_PRUNE_TOOL_NAME = "context_prune";

/** System prompt injected when agentic-auto mode is active */
export const AGENTIC_AUTO_SYSTEM_PROMPT = `[Context Prune — Agentic Auto Mode]
You have access to the context_prune tool. Use it to summarize and compact preceding tool-call results from context.

Why use context_prune:
- Pruning reduces context size, which helps you sustain longer and more complex work without running into context limits.
- Summaries preserve the important takeaways while freeing space for new reasoning and tool use.

How to decide when to prune:
- Prune at a natural task boundary. Call context_prune when the currently pending tool calls all belong to one completed task, investigation, or tightly related subtask.
- Keep each prune cohesive. Do not bundle unrelated work together; if you are about to switch to a different task, prune the completed batch first.
- A good target is usually about 8–12 related tool calls.
- Prune once that task chunk is finished and you are unlikely to need to reread every raw tool result from it again during the rest of the session.
- Avoid pruning too early: calling context_prune after every 2–3 tool calls hurts prompt-cache efficiency.
- Avoid waiting too long: letting more than about 12–13 tool calls pile up before pruning makes the eventual prune job larger and slower.

When NOT to use context_prune:
- Do NOT call it for trivial or single tool calls.
- Do NOT use it in the middle of an active task if you still expect to consult the full raw tool outputs repeatedly.

What happens when you call context_prune:
- All pending tool-call results are summarized into concise bullet points.
- The original full outputs are removed from context but preserved in the session index.
- You can retrieve the full original output at any time using the context_tree_query tool with the short refs listed in the summary.`;

// ── Config ─────────────────────────────────────────────────────────────────

/**
 * When summarization (and context pruning) is triggered.
 * - "every-turn"     : after every assistant turn that calls tools
 * - "on-context-tag" : batches up turns and flushes when the model calls context_tag (legacy) or context_checkpoint (current, ttttmr/pi-context)
 * - "on-demand"      : only when the user runs /pruner now
 * - "agent-message"  : batches up turns and flushes when the agent sends a final text response
 *                       (a turn with no tool calls), or when the agent loop ends (default)
 * - "agentic-auto"   : the LLM agent decides when to prune by calling the context_prune tool;
 *                       the tool is only active in this mode and guided by prompt instructions
 */
export type PruneOn = "every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto";

/**
 * Granularity of pruning batches.
 * - "turn"          : one summary per assistant turn (default; current behavior)
 * - "agent-message" : one summary per full user → final-agent-message span
 *                     (merges all turns between two consecutive user messages)
 */
export type BatchingMode = "turn" | "agent-message";

/** Thinking/reasoning level requested for summarizer LLM calls. */
export type SummarizerThinking = "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Choices for the summarizer thinking setting (used by commands and settings overlay) */
export const SUMMARIZER_THINKING_LEVELS: { value: SummarizerThinking; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

/** Choices for the batching-mode setting (used by commands and settings overlay) */
export const BATCHING_MODES: { value: BatchingMode; label: string }[] = [
  { value: "turn", label: "Per turn" },
  { value: "agent-message", label: "Per agent message" },
];

/**
 * Cycling preset values for the `minBatchChars` setting in the SettingsList.
 * Stored as strings because SettingsList cycles string values; converted to
 * number when applied. `"0"` is the disabled sentinel.
 */
export const MIN_BATCH_CHARS_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0 (disabled)" },
  { value: "500", label: "500" },
  { value: "1000", label: "1000 (default)" },
  { value: "2000", label: "2000" },
  { value: "5000", label: "5000" },
];

/** Choices for the prune-on setting (used by commands and settings overlay) */
export const PRUNE_ON_MODES: { value: PruneOn; label: string }[] = [
  { value: "every-turn", label: "Every turn" },
  { value: "on-context-tag", label: "On context tag" },
  { value: "on-demand", label: "On demand" },
  { value: "agent-message", label: "On agent message" },
  { value: "agentic-auto", label: "Agentic auto" },
];

/** Extension config stored under the `contextPrune` key in `<agent-dir>/settings.json` (agent-dir honors `PI_CODING_AGENT_DIR`). */
export interface ContextPruneConfig {
  /** Whether to prune raw tool outputs from future LLM context */
  enabled: boolean;
  /** Whether to show the prune footer status line and queued turn messages */
  showPruneStatusLine: boolean;
  /**
   * Which model to use for summarization.
   * "default" = current active Pi model (ctx.model)
   * "provider/model-id" = explicit model (e.g. "anthropic/claude-haiku-3-5")
   */
  summarizerModel: string;
  /** Thinking/reasoning level to request for summarizer calls. */
  summarizerThinking: SummarizerThinking;
  /** When to trigger summarization and pruning */
  pruneOn: PruneOn;
  /**
   * Whether to inject a small ephemeral reminder before each LLM call
   * telling the model how many unpruned tool-call results have piled up.
   * Only honored when `enabled && pruneOn === "agentic-auto"`. In all other
   * modes this flag is a no-op (the reminder is meant to nudge the LLM to
   * call `context_prune` at a sensible cadence).
   */
  remindUnprunedCount: boolean;
  /**
   * Granularity of each pruning batch.
   * - "turn"          : one summary per assistant turn (default)
   * - "agent-message" : one summary per user → final-agent-message span
   *                     (all turns between two user messages are merged)
   */
  batchingMode: BatchingMode;
  /**
   * Suppress the UI notification emitted when a batch is skipped — for either
   * reason: (a) the summary would have been larger than the raw tool-result
   * text (oversized), or (b) the batch was below `minBatchChars` and never
   * sent to the summarizer (trivial). The frontier still advances in both
   * cases; only the notification is silenced. Useful for sessions dominated
   * by small tool calls where one or both fire on nearly every turn.
   */
  quietOversizedSkips: boolean;
  /**
   * Pre-flush guard. If the total raw `resultText` character count across all
   * tool calls in a batch is below this threshold, the batch is skipped: no
   * summarizer LLM call is made, no index entry is written, no summary
   * message is injected, and the prune frontier advances past the batch so
   * the same tool calls are not reconsidered on the next flush.
   *
   * Rationale: a short summary like "Tool X did Y" can already be 50–150
   * chars per call. For very small batches (e.g. a 200-byte file read) the
   * summary is near-identical in size or even larger than the raw input, so
   * calling the LLM is wasted cost. The existing post-call `skipped-oversized`
   * mechanism catches this AFTER the LLM round-trip; `minBatchChars` catches
   * the obvious cases BEFORE it, at zero LLM cost.
   *
   * Set to `0` to disable the pre-flush guard entirely (every batch is sent
   * to the summarizer; oversized skipping still applies after the fact).
   *
   * Default: 1000.
   */
  minBatchChars: number;
  /**
   * Tool names whose outputs must NEVER be pruned or summarized. Tool calls
   * with matching `toolName` are filtered out of the pruning capture path so
   * their original `ToolResultMessage` stays verbatim in future LLM context.
   * They are also excluded from the agentic-auto `<pruner-note>`
   * unpruned-count reminder so the LLM is not nudged to prune them.
   *
   * Use for tools whose raw output the agent must keep reading verbatim
   * across turns — for example `todowrite` / `todoread` carrying plan state,
   * or any tool returning a structured handle the agent expects to find
   * unchanged later.
   *
   * Default is `[]` (empty) so behavior is preserved for existing configs and
   * we do not assume which skill-provided tools (e.g. todo*) the user has
   * loaded. Users opt in via `/pruner protected-tools` or the settings file.
   *
   * Matched names are compared by exact tool name; missing / typoed names
   * are silently ignored (they simply never match any captured tool call).
   */
  protectedTools: string[];
  /**
   * Pre-flush content-hash dedup pass. When `true`, each captured tool call
   * is hashed by `(toolName, normalize(resultText))` and compared against
   * records already in the indexer. Matches are registered as aliases of the
   * original via `CUSTOM_TYPE_DEDUP_ALIAS` and removed from the batch BEFORE
   * any summarizer LLM call. The duplicate's `ToolResultMessage` is then
   * stub-replaced by `pruneMessages` using the original's short ref, and
   * `context_tree_query` resolves the duplicate's id back to the original
   * record via the alias map.
   *
   * Normalization is conservative: line-ending normalization (`\r\n` → `\n`),
   * per-line trailing whitespace stripping, plus a final `trim()`. Internal
   * whitespace, tabs, and capitalization are preserved so hashes only match
   * for exact-content duplicates.
   *
   * V1 deliberately dedupes only against records ALREADY in the indexer
   * (i.e. from earlier flushes). Intra-flush dedup is not yet implemented to
   * avoid the case where a "canonical" batch is skipped as oversized or
   * trivial, leaving dangling aliases.
   *
   * Default: `true` — low-risk free win. Set to `false` if you want to keep
   * redundant raw outputs verbatim (e.g. debugging two reads of the same
   * file).
   */
  dedupByContentHash: boolean;
}

export const DEFAULT_CONFIG: ContextPruneConfig = {
  enabled: false,
  showPruneStatusLine: true,
  summarizerModel: "default",
  summarizerThinking: "default",
  pruneOn: "agent-message",
  remindUnprunedCount: true,
  batchingMode: "turn",
  quietOversizedSkips: false,
  minBatchChars: 1000,
  protectedTools: [],
  dedupByContentHash: true,
};

// ── Captured batch ─────────────────────────────────────────────────────────

/** A single tool call + its result as captured from turn_end */
export interface CapturedToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
}

/**
 * One complete batch from a single turn_end event.
 * Represents one assistant turn that contained tool calls.
 */
export interface CapturedBatch {
  turnIndex: number;
  timestamp: number;
  /** Any non-tool-call text from the assistant message (may be empty) */
  assistantText: string;
  toolCalls: CapturedToolCall[];
  /**
   * Grouping key assigned by `captureUnindexedBatchesFromSession`.
   * Increments for each user message seen while walking the branch.
   * Batches from the live `turn_end` path do NOT have this field set
   * (they are always emitted one-per-turn regardless of batchingMode).
   * Used by `groupBatchesByMode` to merge turns within the same
   * user → agent-message span when batchingMode === "agent-message".
   */
  userTurnGroup?: number;
}

// ── Index record ───────────────────────────────────────────────────────────

/**
 * A single tool call record stored in the runtime index.
 * Contains the full original tool output for context_tree_query recovery.
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Full original result text (potentially large; truncated only at query time) */
  resultText: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
}

// ── Session persistence types ──────────────────────────────────────────────

/**
 * Data stored via pi.appendEntry(CUSTOM_TYPE_INDEX, data).
 * One entry per summarized batch; reconstructed into the runtime index on session_start.
 */
export interface IndexEntryData {
  toolCalls: ToolCallRecord[];
}

/**
 * Data stored via pi.appendEntry(CUSTOM_TYPE_DEDUP_ALIAS, data).
 *
 * Each entry maps a duplicate toolCallId to the original (already-indexed)
 * toolCallId whose (toolName, normalized resultText) hash it matched.
 *
 *  - pruneMessages stub-replaces the duplicate's ToolResultMessage using the
 *    original's short ref (via the indexer's toolCallIdToAlias map).
 *  - context_tree_query resolves the duplicate's id back to the original
 *    record via the indexer's dedup alias map.
 *
 * `hash` is optional and stored only for debugging; reconstruction works
 * without it because the original record is re-hashed when its
 * CUSTOM_TYPE_INDEX entry is replayed.
 */
export interface DedupAliasEntryData {
  newToolCallId: string;
  originalToolCallId: string;
  hash?: string;
}

/**
 * Short alias used in the summary message text plus the real toolCallId it
 * maps back to for future recovery through context_tree_query.
 */
export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
}

/**
 * Details stored in the custom summary message's `details` field.
 * Machine-readable metadata so renderers and extensions can inspect summaries.
 */
export interface SummaryMessageDetails {
  toolCallRefs: SummaryToolCallRef[];
  toolNames: string[];
  turnIndex: number;
  timestamp: number;
}

// ── Summarizer stats ────────────────────────────────────────────────────────

/**
 * Cumulative token/cost stats for summarizer LLM calls.
 * Persisted via pi.appendEntry(CUSTOM_TYPE_STATS, ...) so stats survive
 * restarts and branch navigation.
 */
export interface SummarizerStats {
  /** Cumulative input tokens across all summarizer calls */
  totalInputTokens: number;
  /** Cumulative output tokens across all summarizer calls */
  totalOutputTokens: number;
  /** Cumulative cost in USD across all summarizer calls */
  totalCost: number;
  /** Number of summarizer LLM calls made */
  callCount: number;
}

/** Outcome of the most recent completed prune attempt. */
export type PruneFrontierOutcome =
  | "summarized"
  | "skipped-oversized"
  | "skipped-trivial"
  | "skipped-deduped";

/**
 * Snapshot of the last successfully completed prune attempt boundary.
 *
 * This advances both when pruning succeeds and when a summary is rejected for
 * being larger than the raw tool-result text it would replace. Operational
 * failures do not advance the frontier.
 */
export interface PruneFrontier {
  /** Last tool call included in the completed prune attempt */
  lastAttemptedToolCallId: string;
  /** Name of the last tool call included in the completed prune attempt */
  lastAttemptedToolName: string;
  /** Assistant turn index containing the last attempted tool call */
  lastAttemptedTurnIndex: number;
  /** Timestamp captured when that last attempted tool call batch was recorded */
  lastAttemptedTimestamp: number;
  /** Number of batches included in the completed prune attempt */
  attemptedBatchCount: number;
  /** Number of tool calls included in the completed prune attempt */
  attemptedToolCallCount: number;
  /** Character count of the raw tool-result text that was eligible for pruning */
  rawCharCount: number;
  /** Character count of the rendered summary text that was produced */
  summaryCharCount: number;
  /** Whether the attempt actually pruned or was skipped for being oversized */
  outcome: PruneFrontierOutcome;
}

/**
 * Progress callback invoked by `flushPending` when processing batches sequentially.
 * Only fired when the caller passes `onProgress` in `FlushOptions` (i.e. `/pruner now`).
 */
export type ProgressCallback = (
  index: number,
  total: number,
  batch: CapturedBatch,
  stage: "start" | "done" | "skipped",
) => void;

/** Live text-progress callback for a batch currently being summarized. */
export type BatchTextProgressCallback = (
  index: number,
  total: number,
  batch: CapturedBatch,
  receivedChars: number,
) => void;

/** Options accepted by `flushPending`. */
export interface FlushOptions {
  /** Delivery path: "runtime" uses sendMessage/steer (default); "session" writes directly to session. */
  delivery?: "runtime" | "session";
  /**
   * When provided, batches are processed sequentially (one LLM call each) instead of
   * in parallel, and this callback is invoked before/after each batch. Used by
   * `/pruner now` to drive the multi-row progress overlay.
   */
  onProgress?: ProgressCallback;
  /**
   * When provided, receives the number of summary characters streamed so far for
   * the currently-running batch. Used by `/pruner now` to show live progress.
   */
  onBatchTextProgress?: BatchTextProgressCallback;
  /**
   * Pre-captured batches from a prior `capturePendingBatches()` call.
   * When set, `flushPending` skips the internal capture step and uses these directly.
   * Avoids double-capture when the caller needs to know the batch count before
   * opening the progress overlay.
   */
  previewedBatches?: CapturedBatch[];
  /**
   * Abort signal — when fired the in-flight summarization is cancelled and
   * `flushPending` returns `{ ok: false, reason: "aborted" }` without advancing
   * the frontier. All pending batches are restored so the next flush can retry.
   */
  signal?: AbortSignal;
}

/** Options for a single summarizeBatch() call. */
export interface SummarizeBatchOptions {
  /** Receives the number of summary text characters streamed so far. */
  onTextProgress?: (receivedChars: number) => void;
  /**
   * Abort signal — when fired the in-flight stream call is cancelled and the
   * batch is treated as aborted (not a summarizer failure).
   */
  signal?: AbortSignal;
}

/** Options for summarizeBatches() when callers want live per-batch text progress. */
export interface SummarizeBatchesOptions {
  /** Receives streamed summary text character counts for each batch. */
  onBatchTextProgress?: BatchTextProgressCallback;
  /**
   * Abort signal forwarded to every individual summarizeBatch() call.
   * When fired, all in-flight stream calls are cancelled.
   */
  signal?: AbortSignal;
}

/**
 * Result of a summarization call — the summary text plus LLM usage data.
 */
export interface SummarizeResult {
  summaryText: string;
  /** Usage data from the LLM response (tokens + cost) */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}
