import {
  type ContextPruneConfig,
  type SummarizerStats,
  type CapturedBatch,
  type ChainCompressionEntry,
  type FlushOptions,
  PRUNE_ON_MODES,
  BATCHING_MODES,
  STATUS_WIDGET_ID,
  PROGRESS_WIDGET_ID,
  SUMMARIZER_THINKING_LEVELS,
  MIN_BATCH_CHARS_PRESETS,
  AUTO_BUDGET_PRESETS,
  ROLLING_WINDOW_PRESETS,
  KEEP_LAST_TURNS_PRESETS,
  PURGE_COOLDOWN_PRESETS,
  PURGE_MIN_ARG_PRESETS,
  DEFAULT_CONFIG,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { saveConfig } from "./config.js";
import { formatTokens, formatCost, formatCharProgress } from "./stats.js";
import { Container, Text, SettingsList, type SettingItem } from "@mariozechner/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { buildPruneTree, TreeBrowser } from "./tree-browser.js";
import { normalizeSummaryToolCallRefs } from "./summary-refs.js";
import type { ToolCallIndexer } from "./indexer.js";

/**
 * Wraps a SettingsList with a border + title, delegating all input handling
 * to the inner list. Container alone doesn't handle input, so we must
 * forward handleInput manually.
 */
class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }

  invalidate() {
    this.settingsList.invalidate();
  }
}

// ── Status widget text ──────────────────────────────────────────────────────

export function pruneStatusText(config: ContextPruneConfig, stats?: SummarizerStats): string {
  const mode = PRUNE_ON_MODES.find((m) => m.value === config.pruneOn)?.label ?? config.pruneOn;
  let text = `prune: ${config.enabled ? "ON" : "OFF"} (${mode})`;
  if (stats && stats.callCount > 0) {
    text += ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
  }
  return text;
}

export function setPruneStatusWidget(
  ctx: { ui: { setStatus: (id: string, text?: string) => void } },
  config: ContextPruneConfig,
  value?: SummarizerStats | string,
): void {
  if (!config.showPruneStatusLine) {
    ctx.ui.setStatus(STATUS_WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_WIDGET_ID, typeof value === "string" ? value : pruneStatusText(config, value));
}

// ── Subcommand list (for completions & interactive picker) ──────────────────

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "on",       label: "on        — enable context pruning" },
  { value: "off",      label: "off       — disable context pruning" },
  { value: "status",  label: "status    — show status, model, thinking, prune trigger, and status line" },
  { value: "model",   label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on  — show or set the trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode (turn / agent-message)" },
  { value: "stats",   label: "stats     — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree      — browse pruned tool calls in a foldable tree" },
  { value: "now",     label: "now       — flush pending tool calls immediately (widget progress)" },
  { value: "compact", label: "compact   — retroactively compress all eligible closed chains" },
  { value: "protected-tools", label: "protected-tools — show or edit the never-pruned tool allowlist" },
  { value: "min-batch-chars", label: "min-batch-chars — show or set the pre-flush trivial-batch threshold" },
  { value: "dedup",   label: "dedup     — toggle pre-flush content-hash dedup (on/off/status)" },
  { value: "help",    label: "help      — show this help" },
] as const;

// ── Help text ───────────────────────────────────────────────────────────────

const PRUNE_MODE_GUIDANCE: Record<ContextPruneConfig["pruneOn"], string> = {
  "agent-message": "Recommended default. Batches tool work and prunes once after the final text reply, giving the best balance of automation, context savings, and cache stability.",
  "on-demand": "Maximum manual control. Nothing is pruned until you run /pruner now, so cache invalidation happens only when you choose.",
};

function pruneModeGuidance(mode: ContextPruneConfig["pruneOn"]): string {
  return PRUNE_MODE_GUIDANCE[mode] ?? "Controls when summarized tool outputs replace raw tool results in future context.";
}

function pruneModeLabel(mode: ContextPruneConfig["pruneOn"]): string {
  return PRUNE_ON_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}

function summarizerThinkingLabel(level: ContextPruneConfig["summarizerThinking"]): string {
  return SUMMARIZER_THINKING_LEVELS.find((entry) => entry.value === level)?.label ?? level;
}

function summarizerThinkingDescription(level: ContextPruneConfig["summarizerThinking"]): string {
  if (level === "default") {
    return "Preserve old behavior: send no explicit thinking option for summarizer calls.";
  }
  if (level === "off") {
    return "Request no summarizer reasoning where the provider adapter supports it; some providers may fall back to their default.";
  }
  return `Request ${level} thinking/reasoning for summarizer calls where supported.`;
}

function parseModelAndThinkingArg(
  value: string,
): { model: string; thinking?: ContextPruneConfig["summarizerThinking"]; error?: string } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex === -1) {
    return { model: value };
  }

  const model = value.slice(0, separatorIndex);
  const suffix = value.slice(separatorIndex + 1);
  const thinking = SUMMARIZER_THINKING_LEVELS.find((level) => level.value === suffix)?.value;
  if (!model || !thinking) {
    return {
      model: value,
      error: `Invalid model thinking suffix: ${suffix}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`,
    };
  }
  return { model, thinking };
}

function pruneTriggerDescription(mode: ContextPruneConfig["pruneOn"]): string {
  return `When to summarize tool outputs. Current mode: ${pruneModeLabel(mode)} (${mode}) — ${pruneModeGuidance(mode)} Press Enter/Space to cycle through modes.`;
}

function batchingModeLabel(mode: ContextPruneConfig["batchingMode"]): string {
  return BATCHING_MODES.find((m) => m.value === mode)?.label ?? mode;
}

function batchingModeDescription(mode: ContextPruneConfig["batchingMode"]): string {
  if (mode === "turn") {
    return "Per turn (default): one summary per assistant turn. Keeps summaries small and granular.";
  }
  return "Per agent message: merges all assistant turns between two user messages into one summary. Fewer, larger summaries per conversation exchange.";
}

function pruneStatusLineDescription(config: ContextPruneConfig): string {
  const base = config.showPruneStatusLine ? "ON" : "OFF";
  if (config.showPruneStatusLine) {
    return `Show the prune footer status line and queued turn notifications. Currently ${base}.`;
  }
  return `Hide the prune footer status line and queued turn notifications. Currently ${base}.`;
}

function quietOversizedSkipsDescription(config: ContextPruneConfig): string {
  const base = config.quietOversizedSkips ? "ON" : "OFF";
  if (config.quietOversizedSkips) {
    return `Suppress all non-error 'skipped pruning' notifications — both 'oversized' (summary was larger than the raw output) and 'trivial' (batch was below minBatchChars, no LLM call made). The frontier still advances in both cases. Currently ${base}.`;
  }
  return `Show 'skipped pruning' info notifications when a batch is skipped — either because the summary would have been larger than the raw output (oversized) or because the batch was below minBatchChars (trivial, no LLM call). Currently ${base}.`;
}

function minBatchCharsDescription(config: ContextPruneConfig): string {
  if (config.minBatchChars === 0) {
    return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently 0 — disabled, every batch is sent to the summarizer.`;
  }
  return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently ${config.minBatchChars}. Useful for sessions with many tiny tool calls. Set to 0 to disable.`;
}

function autoBudgetThresholdDescription(config: ContextPruneConfig): string {
  if (config.autoBudgetThreshold == null) {
    return `Token-budget auto-flush: force a prune when context usage reaches this share of the window, regardless of prune-on mode. Currently off. Pick a percentage to enable.`;
  }
  return `Token-budget auto-flush: force a prune when context usage reaches ${Math.round(config.autoBudgetThreshold * 100)}% of the window, regardless of prune-on mode. Set to Off to disable.`;
}

function protectedToolsDisplay(list: string[]): string {
  return list.length === 0 ? "(none)" : list.join(", ");
}

function dedupByContentHashDescription(config: ContextPruneConfig): string {
  const state = config.dedupByContentHash ? "ON" : "OFF";
  if (config.dedupByContentHash) {
    return `Pre-flush content-hash dedup. When a captured tool call's (toolName, normalized resultText) matches a record already in the indexer, the duplicate is registered as an alias of the original — no summarizer LLM call. Currently ${state}.`;
  }
  return `Pre-flush content-hash dedup. Currently ${state}. Identical re-reads will be sent to the summarizer like any other tool call.`;
}

function protectedToolsDescription(config: ContextPruneConfig): string {
  return `Tool names whose outputs are NEVER pruned (kept verbatim in context). Currently: ${protectedToolsDisplay(config.protectedTools)}. Edit via \`/pruner protected-tools\` for an interactive prompt, or \`/pruner protected-tools <comma-separated names>\` to set directly. Common candidates: todowrite, todoread.`;
}

const HELP_TEXT = `pruner — automatically summarizes tool-call outputs to keep context lean.

Usage:
  /pruner settings                         Interactive settings overlay
  /pruner on                               Enable context pruning
  /pruner off                              Disable context pruning
  /pruner status                           Show status, model, prune trigger, batching mode, and stats
  /pruner model                            Show the current summarizer model
  /pruner model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /pruner model <id>:<thinking>            Set summarizer model and thinking together (e.g. openai/gpt-5-mini:low)
  /pruner thinking                         Show the current summarizer thinking level
  /pruner thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /pruner prune-on                         Show or interactively pick the trigger
  /pruner prune-on on-demand               Only summarize when /pruner now runs
  /pruner prune-on agent-message           Summarize after the agent's final text reply (default; safest for cache stability)
  /pruner batching                         Show or interactively pick the batching granularity
  /pruner batching turn                    One summary per assistant turn (default)
  /pruner batching agent-message           One summary per user→final-agent-message span (merges all turns in a span)
  /pruner stats                            Show cumulative summarizer token/cost stats
  /pruner tree                             Browse pruned tool calls in a foldable tree (Ctrl-O opens selected summary)
  /pruner now                              Flush pending tool calls immediately (shows live footer progress)
  /pruner protected-tools                  Interactively edit the never-pruned tool allowlist
  /pruner protected-tools <names>          Set the allowlist (comma- or space-separated; 'none' clears)
  /pruner min-batch-chars                  Show the current pre-flush trivial-batch threshold
  /pruner min-batch-chars <n>              Set the threshold (non-negative integer; 0 disables)
  /pruner compact                          Retroactively compress all closed chains (ignores rollingWindow; force-compresses every eligible chain)
  /pruner dedup                            Show the current pre-flush content-hash dedup state
  /pruner dedup on|off                     Enable or disable content-hash dedup
  /pruner help                             Show this help

Trivial-batch skip (minBatchChars):
  If the total raw resultText across a batch is below minBatchChars, the
  batch is skipped: no summarizer LLM call is made, no summary message is
  injected, and the prune frontier still advances so the same tool calls are
  not reconsidered next flush. Default is 1000. Set to 0 to disable.
  This runs BEFORE summarization, so it is cheaper than the post-LLM
  skipped-oversized path that also rejects summaries larger than the raw
  input. Both skip notifications are silenced by quietOversizedSkips.

Protected tools:
  Some tools' outputs must stay verbatim across turns — typically planning tools
  like todowrite / todoread that carry state the agent re-reads later. List
  those tool names in 'protectedTools' (settings) or via /pruner protected-tools.
  Protected calls bypass the summarizer/index entirely: their raw
  ToolResultMessage stays in context. Names that don't match any captured
  tool call are silently ignored.

Content-hash dedup (dedupByContentHash):
  When ON (default), each captured tool call is hashed by
  (toolName, normalize(resultText)) using SHA-1 and compared against records
  already in the indexer. If an earlier prune already covered identical
  content, the duplicate is registered as an alias of the original — no
  summarizer LLM call is made, the duplicate's ToolResultMessage gets
  stub-replaced via pruneMessages, and context_tree_query returns the
  original record when asked with the duplicate's id. Normalization is
  conservative: line endings, per-line trailing whitespace, and a final
  trim() only. Internal whitespace and capitalization are preserved.
  V1 dedupes only against records ALREADY in the indexer (from previous
  flushes); intra-flush dedup is deferred to v2 to avoid dangling aliases
  when a canonical batch is skipped as oversized / trivial.

Batching mode:
  - turn (default): each assistant turn that used tools gets its own summary block. Small, granular.
  - agent-message: all assistant turns between two consecutive user messages are merged into one summary.
    Use this when a single user request triggers many back-to-back tool rounds that belong together.

Mode guidance:
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
  - agent-message: recommended default. Batches a whole tool-using run, then prunes once after the final text reply so future requests become cacheable again.

Why this matters:
  Frequent edits to earlier context can reduce prompt/prefix cache hits on providers that cache identical prefixes. Batched pruning is usually cheaper and faster than pruning every turn.

Related:
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

Settings are saved under the "contextPrune" key in <agent-dir>/settings.json (where <agent-dir> is $PI_CODING_AGENT_DIR or ~/.pi/agent).`;

// ── Pruner progress widget ────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

type RowStatus = "pending" | "running" | "done" | "skipped";

interface WidgetRow {
  label: string;
  toolCallCount: number;
  rawChars: number;
  status: RowStatus;
  receivedChars: number;
}

/**
 * Registers a multi-row progress widget above the editor for /pruner now.
 * Returns helpers to update row state and clear the widget when done.
 * Each row shows a spinner, label, tool-call count, and live summary char count.
 */
function startPrunerWidget(
  ctx: ExtensionCommandContext,
  batches: CapturedBatch[],
): {
  updateRow: (index: number, status: RowStatus, chars?: number) => void;
  clearWidget: () => void;
} {
  const total = batches.length;
  const rows: WidgetRow[] = batches.map((b, i) => ({
    label: `Batch ${i + 1}/${total}`,
    toolCallCount: b.toolCalls.length,
    rawChars: b.toolCalls.reduce((sum, tc) => sum + tc.resultText.length, 0),
    status: "pending",
    receivedChars: 0,
  }));

  // Capture tui reference from the factory so updateRow can call requestRender.
  let requestRender: (() => void) | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  const hasRunningRows = () => rows.some((row) => row.status === "running");

  const stopAnimationLoop = () => {
    if (!animationTimer) return;
    clearInterval(animationTimer);
    animationTimer = undefined;
  };

  // The widget only re-renders when Pi is asked to draw again. Drive a tiny
  // timer while any row is running so the spinner advances even before the
  // summarizer streams its first text chunk.
  const ensureAnimationLoop = () => {
    if (animationTimer || !requestRender || !hasRunningRows()) return;
    animationTimer = setInterval(() => {
      if (!hasRunningRows()) {
        stopAnimationLoop();
        return;
      }
      requestRender?.();
    }, SPINNER_INTERVAL_MS);
    animationTimer.unref?.();
  };

  const syncAnimationLoop = () => {
    if (hasRunningRows()) {
      ensureAnimationLoop();
    } else {
      stopAnimationLoop();
    }
    requestRender?.();
  };

  ctx.ui.setWidget(
    PROGRESS_WIDGET_ID,
    (tui, _theme) => {
      requestRender = () => tui.requestRender();
      syncAnimationLoop();
      return {
        invalidate() {},
        render(_width: number): string[] {
          return rows.map((row) => {
            const count = `${row.toolCallCount} tool call${row.toolCallCount === 1 ? "" : "s"}`;
            if (row.status === "running") {
              const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
              const chars =
                row.receivedChars > 0
                  ? ` · ${formatCharProgress(row.receivedChars, row.rawChars)}`
                  : "";
              return `${frame} ${row.label} · ${count}${chars}`;
            } else if (row.status === "done") {
              return `✓ ${row.label} · ${count} · ${formatCharProgress(row.receivedChars, row.rawChars)}`;
            } else if (row.status === "skipped") {
              return `⚠ ${row.label} · ${count} · skipped`;
            } else {
              return `○ ${row.label} · ${count} · pending`;
            }
          });
        },
      };
    },
    { placement: "aboveEditor" },
  );

  return {
    updateRow(index: number, status: RowStatus, chars?: number) {
      if (index >= 0 && index < rows.length) {
        rows[index].status = status;
        if (chars !== undefined) rows[index].receivedChars = chars;
        syncAnimationLoop();
      }
    },
    clearWidget() {
      stopAnimationLoop();
      requestRender = undefined;
      ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
    },
  };
}

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<
    | { ok: true; reason: "flushed" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number; dedupedCount?: number }
    | { ok: false; reason: string; error?: string }
  >,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  getStats: () => SummarizerStats,
  indexer: ToolCallIndexer,
  compactChains: (ctx: ExtensionCommandContext) => Promise<{ compressedEntries: ChainCompressionEntry[]; skipped: number }>,
): void {
  // Register the /pruner command
  pi.registerCommand("pruner", {
    description: "Context-prune settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      // Parse subcommand and remaining args from the raw argument string
      const parts = args.trim().split(/\s+/);
      let subcommand = parts[0] || undefined;
      const subArgs = parts.slice(1); // e.g. ["model", "anthropic/claude-haiku-3-5"] or ["on"])

      // ── Bare /pruner → interactive picker ──
      if (!subcommand) {
        const options = SUBCOMMANDS.map((s) => s.label);
        const choice = await ctx.ui.select("pruner — choose a subcommand", options);
        if (!choice) return;
        // Extract the value (first word) from the label like "settings — interactive settings overlay"
        subcommand = choice.split(/\s+/)[0];
      }

      switch (subcommand) {
        // ── /pruner settings ── interactive overlay ──
        case "settings": {
          const config = currentConfig.value;
          const availableModels = ctx.modelRegistry?.getAvailable() ?? [];

          const items: SettingItem[] = [
            {
              id: "enabled",
              label: "Enabled",
              values: ["true", "false"],
              currentValue: String(config.enabled),
              description: "Enable or disable context pruning",
            },
            {
              id: "showPruneStatusLine",
              label: "Prune status line",
              values: ["true", "false"],
              currentValue: String(config.showPruneStatusLine),
              description: pruneStatusLineDescription(config),
            },
            {
              id: "pruneOn",
              label: "Prune trigger",
              values: PRUNE_ON_MODES.map((m) => m.value),
              currentValue: config.pruneOn,
              description: pruneTriggerDescription(config.pruneOn),
            },
            {
              id: "summarizerModel",
              label: "Summarizer model",
              values: [config.summarizerModel], // show current value as the cycling option
              currentValue: config.summarizerModel,
              description: "Model used for summarizing tool outputs — press Enter to browse models",
              submenu: (currentValue: string, done: (newValue?: string) => void) => {
                const modelItems: SettingItem[] = [
                  {
                    id: "default",
                    label: "default (active model)",
                    values: ["default"],
                    currentValue: currentValue === "default" ? "default" : "",
                    description: "Use the currently active model for summarization",
                  },
                  ...availableModels.map((m) => {
                    const displayId = `${m.provider}/${m.id}`;
                    return {
                      id: displayId,
                      label: displayId,
                      values: [displayId],
                      currentValue: currentValue === displayId ? displayId : "",
                      description: m.name || displayId,
                    };
                  }),
                ];
                return new SettingsList(
                  modelItems,
                  15,
                  getSettingsListTheme(),
                  (_id: string, newValue: string) => done(newValue),
                  () => done(undefined), // onCancel — ESC closes submenu, returns to parent
                  { enableSearch: true },
                );
              },
            },
            {
              id: "summarizerThinking",
              label: "Summarizer thinking",
              values: SUMMARIZER_THINKING_LEVELS.map((level) => level.value),
              currentValue: config.summarizerThinking,
              description: summarizerThinkingDescription(config.summarizerThinking),
            },
            {
              id: "batchingMode",
              label: "Batching mode",
              values: BATCHING_MODES.map((m) => m.value),
              currentValue: config.batchingMode,
              description: batchingModeDescription(config.batchingMode),
            },
            {
              id: "quietOversizedSkips",
              label: "Quiet skip notifications",
              values: ["true", "false"],
              currentValue: String(config.quietOversizedSkips),
              description: quietOversizedSkipsDescription(config),
            },
            {
              id: "minBatchChars",
              label: "Min batch chars",
              values: MIN_BATCH_CHARS_PRESETS.map((p) => p.value),
              currentValue: MIN_BATCH_CHARS_PRESETS.some((p) => p.value === String(config.minBatchChars))
                ? String(config.minBatchChars)
                : MIN_BATCH_CHARS_PRESETS[2].value, // fall back to "1000" if a custom value isn't in the preset cycle
              description: minBatchCharsDescription(config),
            },
            {
              id: "autoBudgetThreshold",
              label: "Auto-flush at context %",
              values: AUTO_BUDGET_PRESETS.map((p) => p.value),
              currentValue: (() => {
                const v = config.autoBudgetThreshold == null ? "0" : String(config.autoBudgetThreshold);
                return AUTO_BUDGET_PRESETS.some((p) => p.value === v) ? v : "0";
              })(),
              description: autoBudgetThresholdDescription(config),
            },
            {
              id: "dedupByContentHash",
              label: "Dedup by content hash",
              values: ["true", "false"],
              currentValue: String(config.dedupByContentHash),
              description: dedupByContentHashDescription(config),
            },
            {
              id: "chainCompressionEnabled",
              label: "Chain compression",
              values: ["true", "false"],
              currentValue: String(config.chainCompression.enabled),
              description: `Range-compress closed chains beyond the rolling window (K=${config.chainCompression.rollingWindow}). Drops middle assistant turns + tool results, injects a synthetic summary. Currently ${config.chainCompression.enabled ? "ON" : "OFF"}.`,
            },
            {
              id: "chainCompressionRollingWindow",
              label: "Chain window (K)",
              values: ROLLING_WINDOW_PRESETS.map((p) => p.value),
              // Fall back to the closest preset if the persisted value isn't in the cycle
              // (e.g. user hand-edited settings.json with a non-preset integer).
              currentValue: ROLLING_WINDOW_PRESETS.some((p) => p.value === String(config.chainCompression.rollingWindow))
                ? String(config.chainCompression.rollingWindow)
                : ROLLING_WINDOW_PRESETS[2].value,
              description: `Keep the K most-recently-closed chains raw; compress older ones. Currently ${config.chainCompression.rollingWindow}.`,
            },
            {
              id: "chainCompressionStripThinking",
              label: "Strip final thinking",
              values: ["true", "false"],
              currentValue: String(config.chainCompression.stripFinalAssistantThinking),
              description: `Strip thinking blocks from the kept final text-only assistant message when compressing a chain. Currently ${config.chainCompression.stripFinalAssistantThinking ? "ON" : "OFF"}.`,
            },
            {
              id: "chainCompressionFuseRange",
              label: "Fuse range summary",
              values: ["true", "false"],
              currentValue: String(config.chainCompression.fuseRangeSummary),
              description: `Fuse a compressed chain's per-batch summaries into one cohesive LLM summary (one extra summarizer call per multi-batch span). Off keeps the per-batch concatenation. Currently ${config.chainCompression.fuseRangeSummary ? "ON" : "OFF"}.`,
            },
            {
              id: "thinkingStripEnabled",
              label: "Thinking strip",
              values: ["true", "false"],
              currentValue: String(config.thinkingStrip.enabled),
              description: `Strip thinking blocks from assistant turns older than the last ${config.thinkingStrip.keepLastTurns}. Reclaims main-loop thinking accumulation; no-op under ${config.thinkingStrip.keepLastTurns} turns. Currently ${config.thinkingStrip.enabled ? "ON" : "OFF"}.`,
            },
            {
              id: "thinkingStripKeepLastTurns",
              label: "Thinking keep (last N turns)",
              values: KEEP_LAST_TURNS_PRESETS.map((p) => p.value),
              currentValue: KEEP_LAST_TURNS_PRESETS.some((p) => p.value === String(config.thinkingStrip.keepLastTurns))
                ? String(config.thinkingStrip.keepLastTurns)
                : KEEP_LAST_TURNS_PRESETS[2].value,
              description: `Keep thinking on the last N assistant turns; strip older. Counts assistant turns, not chains. Currently ${config.thinkingStrip.keepLastTurns}.`,
            },
            {
              id: "purgeErrorsEnabled",
              label: "Error purge",
              values: ["true", "false"],
              currentValue: String(config.purgeErrors.enabled),
              description: `Replace failed toolCall argument bodies with compact stubs after a cooldown. Reclaims context from large write/edit args that will never succeed. Currently ${config.purgeErrors.enabled ? "ON" : "OFF"}.`,
            },
            {
              id: "purgeErrorsCooldown",
              label: "Error purge cooldown (turns)",
              values: PURGE_COOLDOWN_PRESETS.map((p) => p.value),
              currentValue: PURGE_COOLDOWN_PRESETS.some((p) => p.value === String(config.purgeErrors.cooldownTurns))
                ? String(config.purgeErrors.cooldownTurns)
                : PURGE_COOLDOWN_PRESETS[1].value,
              description: `Wait this many turns after a tool error before purging its argument body. Currently ${config.purgeErrors.cooldownTurns}.`,
            },
            {
              id: "purgeErrorsMinArgChars",
              label: "Error purge min arg chars",
              values: PURGE_MIN_ARG_PRESETS.map((p) => p.value),
              currentValue: PURGE_MIN_ARG_PRESETS.some((p) => p.value === String(config.purgeErrors.minArgChars))
                ? String(config.purgeErrors.minArgChars)
                : PURGE_MIN_ARG_PRESETS[1].value,
              description: `Only purge arg bodies at least this many chars. Currently ${config.purgeErrors.minArgChars}.`,
            },
            {
              // Read-only display row. Editing goes through `/pruner protected-tools`
              // because SettingsList.submenu requires a synchronous Component,
              // while editing a free-form list needs `ctx.ui.input()` (async).
              id: "protectedTools",
              label: "Protected tools",
              values: [protectedToolsDisplay(config.protectedTools)],
              currentValue: protectedToolsDisplay(config.protectedTools),
              description: protectedToolsDescription(config),
            },
          ];

          let settingsList: SettingsList;
          let closeSettingsOverlay = () => {};

          const onChange = (id: string, newValue: string) => {
            // Read-only row — SettingsList still fires onChange when the user
            // presses Enter on a single-value item. Short-circuit so we don't
            // do a redundant saveConfig / status-widget refresh on no-op presses.
            if (id === "protectedTools") return;
            const newConfig = { ...currentConfig.value };
            if (id === "enabled") {
              newConfig.enabled = newValue === "true";
            } else if (id === "showPruneStatusLine") {
              newConfig.showPruneStatusLine = newValue === "true";
              const statusLineItem = items.find((item) => item.id === "showPruneStatusLine");
              if (statusLineItem) {
                statusLineItem.description = pruneStatusLineDescription(newConfig);
              }
            } else if (id === "pruneOn") {
              newConfig.pruneOn = newValue as ContextPruneConfig["pruneOn"];
              const pruneTriggerItem = items.find((item) => item.id === "pruneOn");
              if (pruneTriggerItem) {
                pruneTriggerItem.description = pruneTriggerDescription(newConfig.pruneOn);
              }
            } else if (id === "summarizerModel") {
              newConfig.summarizerModel = newValue;
            } else if (id === "summarizerThinking") {
              newConfig.summarizerThinking = newValue as ContextPruneConfig["summarizerThinking"];
              const thinkingItem = items.find((item) => item.id === "summarizerThinking");
              if (thinkingItem) {
                thinkingItem.description = summarizerThinkingDescription(newConfig.summarizerThinking);
              }
            } else if (id === "batchingMode") {
              newConfig.batchingMode = newValue as ContextPruneConfig["batchingMode"];
              const batchingItem = items.find((item) => item.id === "batchingMode");
              if (batchingItem) {
                batchingItem.description = batchingModeDescription(newConfig.batchingMode);
              }
            } else if (id === "quietOversizedSkips") {
              newConfig.quietOversizedSkips = newValue === "true";
              const quietItem = items.find((item) => item.id === "quietOversizedSkips");
              if (quietItem) {
                quietItem.description = quietOversizedSkipsDescription(newConfig);
              }
            } else if (id === "minBatchChars") {
              const parsed = Number.parseInt(newValue, 10);
              newConfig.minBatchChars = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.minBatchChars;
              const mbItem = items.find((item) => item.id === "minBatchChars");
              if (mbItem) {
                mbItem.description = minBatchCharsDescription(newConfig);
              }
            } else if (id === "autoBudgetThreshold") {
              const parsed = Number.parseFloat(newValue);
              newConfig.autoBudgetThreshold =
                Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : null;
              const abItem = items.find((item) => item.id === "autoBudgetThreshold");
              if (abItem) {
                abItem.description = autoBudgetThresholdDescription(newConfig);
              }
            } else if (id === "dedupByContentHash") {
              newConfig.dedupByContentHash = newValue === "true";
              const dedupItem = items.find((item) => item.id === "dedupByContentHash");
              if (dedupItem) {
                dedupItem.description = dedupByContentHashDescription(newConfig);
              }
            } else if (id === "chainCompressionEnabled") {
              newConfig.chainCompression = { ...newConfig.chainCompression, enabled: newValue === "true" };
            } else if (id === "chainCompressionRollingWindow") {
              const parsed = Number.parseInt(newValue, 10);
              newConfig.chainCompression = {
                ...newConfig.chainCompression,
                rollingWindow: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.chainCompression.rollingWindow,
              };
            } else if (id === "chainCompressionStripThinking") {
              newConfig.chainCompression = { ...newConfig.chainCompression, stripFinalAssistantThinking: newValue === "true" };
            } else if (id === "chainCompressionFuseRange") {
              newConfig.chainCompression = { ...newConfig.chainCompression, fuseRangeSummary: newValue === "true" };
            } else if (id === "thinkingStripEnabled") {
              newConfig.thinkingStrip = { ...newConfig.thinkingStrip, enabled: newValue === "true" };
            } else if (id === "thinkingStripKeepLastTurns") {
              const parsed = Number.parseInt(newValue, 10);
              newConfig.thinkingStrip = {
                ...newConfig.thinkingStrip,
                keepLastTurns: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.thinkingStrip.keepLastTurns,
              };
            } else if (id === "purgeErrorsEnabled") {
              newConfig.purgeErrors = { ...newConfig.purgeErrors, enabled: newValue === "true" };
            } else if (id === "purgeErrorsCooldown") {
              const parsed = Number.parseInt(newValue, 10);
              newConfig.purgeErrors = {
                ...newConfig.purgeErrors,
                cooldownTurns: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.purgeErrors.cooldownTurns,
              };
            } else if (id === "purgeErrorsMinArgChars") {
              const parsed = Number.parseInt(newValue, 10);
              newConfig.purgeErrors = {
                ...newConfig.purgeErrors,
                minArgChars: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.purgeErrors.minArgChars,
              };
            }
            currentConfig.value = newConfig;
            saveConfig(newConfig);
            setPruneStatusWidget(ctx, newConfig, getStats());
            settingsList?.invalidate();
          };

          settingsList = new SettingsList(
            items,
            10,
            getSettingsListTheme(),
            onChange,
            () => closeSettingsOverlay(), // onCancel — close the custom overlay
            { enableSearch: false },
          );

          // Use ctx.ui.custom() to show the settings list as an overlay.
          // The factory receives (tui, theme, keybindings, done) and returns a Component.
          // Wire Escape through the SettingsList constructor's onCancel callback instead
          // of mutating private SettingsList fields.
          await ctx.ui.custom(
            (_tui, _theme, _keybindings, done) => {
              closeSettingsOverlay = () => done(undefined);
              return new SettingsOverlay("pruner settings", settingsList);
            },
            {
              overlay: true,
              overlayOptions: { width: 60 },
            },
          );
          break;
        }

        // ── /pruner on ──
        case "on": {
          currentConfig.value = { ...currentConfig.value, enabled: true };
          saveConfig(currentConfig.value);
          ctx.ui.notify("Context pruning enabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          break;
        }

        // ── /pruner off ──
        case "off": {
          currentConfig.value = { ...currentConfig.value, enabled: false };
          saveConfig(currentConfig.value);
          ctx.ui.notify("Context pruning disabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          break;
        }

        // ── /pruner status ──
        case "status": {
          const cfg = currentConfig.value;
          const mode = PRUNE_ON_MODES.find((m) => m.value === cfg.pruneOn)?.label ?? cfg.pruneOn;
          const s = getStats();
          const statsLine = s.callCount > 0
            ? `\n  --- summarizer ---\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`
            : "\n  (no summarizer calls yet)";
          ctx.ui.notify(
            `pruner status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${summarizerThinkingLabel(cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  trigger:  ${mode}\n  batching: ${batchingModeLabel(cfg.batchingMode)} (${cfg.batchingMode})\n  dedup:    ${cfg.dedupByContentHash ? "on" : "off"}\n  status:   ${cfg.showPruneStatusLine ? "on" : "off"}${statsLine}`,
          );
          break;
        }

        // ── /pruner tree ── foldable tree browser ──
        case "tree": {
          const roots = buildPruneTree(ctx, indexer);
          if (roots.length === 0) {
            ctx.ui.notify("No pruned tool calls found in this session.", "info");
            break;
          }

          await ctx.ui.custom(
            (_tui, theme, _keybindings, done) => {
              const browser = new TreeBrowser(roots, theme, () => done(undefined));
              return browser;
            },
            {
              overlay: true,
              overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" },
            },
          );
          break;
        }

        // ── /pruner stats ──
        case "stats": {
          const s = getStats();
          if (s.callCount === 0 && s.chainsCompressed === 0) {
            ctx.ui.notify("pruner stats: no summarizer calls yet.");
          } else {
            const chainsLine = s.chainsCompressed > 0 ? `\n  chains:      ${s.chainsCompressed} compressed` : "";
            ctx.ui.notify(
              `pruner stats:\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}${chainsLine}`,
            );
          }
          break;
        }

        // ── /pruner model [value] ──
        case "model": {
          const modelArg = subArgs[0];
          if (!modelArg) {
            ctx.ui.notify(
              `Current summarizer model: ${currentConfig.value.summarizerModel}\nCurrent summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
            );
          } else {
            const parsed = parseModelAndThinkingArg(modelArg);
            if (parsed.error) {
              ctx.ui.notify(parsed.error, "warning");
              return;
            }
            currentConfig.value = {
              ...currentConfig.value,
              summarizerModel: parsed.model,
              summarizerThinking: parsed.thinking ?? currentConfig.value.summarizerThinking,
            };
            saveConfig(currentConfig.value);
            const thinkingText = parsed.thinking ? ` with thinking ${parsed.thinking}` : "";
            ctx.ui.notify(`Summarizer model set to: ${parsed.model}${thinkingText}`);
          }
          break;
        }

        // ── /pruner thinking [value] ──
        case "thinking": {
          const thinkingArg = subArgs[0];
          if (!thinkingArg) {
            ctx.ui.notify(
              `Current summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
            );
            return;
          }
          if (SUMMARIZER_THINKING_LEVELS.some((level) => level.value === thinkingArg)) {
            currentConfig.value = {
              ...currentConfig.value,
              summarizerThinking: thinkingArg as ContextPruneConfig["summarizerThinking"],
            };
          } else {
            ctx.ui.notify(
              `Invalid summarizer thinking level: ${thinkingArg}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`,
              "warning",
            );
            return;
          }
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Summarizer thinking set to: ${currentConfig.value.summarizerThinking}`);
          break;
        }

        // ── /pruner prune-on [value] ──
        case "prune-on": {
          const modeArg = subArgs[0];
          if (!modeArg) {
            const options = PRUNE_ON_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose when to trigger summarization", options);
            if (!choice) return;
            // Extract the value (first word) from "agent-message — On agent message"
            const chosenValue = choice.split(/\s+/)[0] as ContextPruneConfig["pruneOn"];
            currentConfig.value = { ...currentConfig.value, pruneOn: chosenValue };
          } else {
            currentConfig.value = { ...currentConfig.value, pruneOn: modeArg as ContextPruneConfig["pruneOn"] };
          }
          saveConfig(currentConfig.value);
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          break;
        }

        // ── /pruner batching [value] ──
        case "batching": {
          const batchArg = subArgs[0];
          if (!batchArg) {
            const options = BATCHING_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose batching granularity", options);
            if (!choice) return;
            const chosenValue = choice.split(/\s+/)[0] as ContextPruneConfig["batchingMode"];
            currentConfig.value = { ...currentConfig.value, batchingMode: chosenValue };
          } else {
            if (!BATCHING_MODES.some((m) => m.value === batchArg)) {
              ctx.ui.notify(
                `Invalid batching mode: ${batchArg}. Use one of: ${BATCHING_MODES.map((m) => m.value).join(", ")}.`,
                "warning",
              );
              return;
            }
            currentConfig.value = { ...currentConfig.value, batchingMode: batchArg as ContextPruneConfig["batchingMode"] };
          }
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Batching mode set to: ${batchingModeLabel(currentConfig.value.batchingMode)}`);
          break;
        }

        // ── /pruner compact ──
        // Runs regardless of chainCompression.enabled — that flag gates automatic compression;
        // the user invoking /pruner compact is explicit intent.
        case "compact": {
          try {
            const { compressedEntries, skipped } = await compactChains(ctx);
            if (compressedEntries.length === 0) {
              ctx.ui.notify(
                skipped > 0
                  ? `pruner: no chains eligible for compaction (${skipped} skipped — no per-batch summary available)`
                  : "pruner: no chains eligible for compaction",
                "info",
              );
              break;
            }
            // Coarse estimate: uses original (unstubbed) toolResult sizes which overstates
            // tool-result savings; but assistant-message savings (thinking + toolCall args + text)
            // are not counted at all, so the two errors partly cancel. Treat as a rough proxy.
            const droppedChars = compressedEntries.reduce((total, entry) => {
              const records = indexer.lookupToolCalls(entry.droppedToolCallIds);
              return total + records.reduce((s, r) => s + r.resultText.length, 0);
            }, 0);
            const reclaimedTokens = Math.ceil(droppedChars / 4);
            const ids = compressedEntries.map((e) => e.blockId).join(", ");
            ctx.ui.notify(
              `pruner: compacted ${compressedEntries.length} chain${compressedEntries.length === 1 ? "" : "s"} (${ids}), reclaimed ~${reclaimedTokens} tokens`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`pruner: compact failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
          break;
        }

        // ── /pruner now ──
        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
            return;
          }

          // Capture the pending queue first so we can pre-build the widget rows.
          const batches = capturePendingBatches(ctx);
          if (batches.length === 0) {
            ctx.ui.notify("pruner: nothing pending — no batches to summarize", "info");
            break;
          }

          // Open the progress widget above the editor — one row per batch.
          const { updateRow, clearWidget } = startPrunerWidget(ctx, batches);

          const result = await flushPending(ctx, {
            previewedBatches: batches,
            onProgress: (index, _total, _batch, stage) => {
              if (stage === "start") {
                updateRow(index, "running", 0);
              } else if (stage === "done") {
                updateRow(index, "done");
              } else {
                updateRow(index, "skipped");
              }
            },
            onBatchTextProgress: (index, _total, _batch, receivedChars) => {
              updateRow(index, "running", receivedChars);
            },
          });

          // Remove the widget and restore the normal footer status.
          clearWidget();
          setPruneStatusWidget(ctx, currentConfig.value, getStats());

          if (!result.ok) {
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`pruner: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
            break;
          }

          if (result.reason === "skipped-oversized") {
            ctx.ui.notify(
              `pruner: skipped pruning ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars; frontier advanced past this range`,
              "warning"
            );
            break;
          }

          if (result.reason === "skipped-trivial") {
            ctx.ui.notify(
              `pruner: skipped ${result.toolCallCount} trivial tool call${result.toolCallCount === 1 ? "" : "s"} — only ${result.rawCharCount} raw chars below minBatchChars=${currentConfig.value.minBatchChars}; no LLM call made; frontier advanced past this range`,
              "info"
            );
            break;
          }

          if (result.reason === "skipped-deduped") {
            const n = result.dedupedCount ?? result.toolCallCount;
            ctx.ui.notify(
              `pruner: deduplicated ${n} tool call${n === 1 ? "" : "s"} (${result.rawCharCount} raw chars) against earlier prunes; no LLM call made; frontier advanced past this range`,
              "info"
            );
            break;
          }

          ctx.ui.notify(
            `pruner: pruned ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"} — summary ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`,
            "info"
          );
          break;
        }

        // ── /pruner protected-tools [list] ──
        // Bare form opens ctx.ui.input() so the user can edit the list
        // interactively (pre-filled with the current value).  Argument form
        // accepts a comma- and/or whitespace-separated list, or the sentinels
        // `none` / `clear` to empty the list.
        case "protected-tools": {
          const raw = subArgs.join(" ").trim();
          let nextList: string[] | undefined;

          if (!raw) {
            const currentDisplay =
              currentConfig.value.protectedTools.length === 0
                ? ""
                : currentConfig.value.protectedTools.join(", ");
            const entered = await ctx.ui.input(
              "Protected tools (comma-separated tool names; empty or 'none' to clear)",
              currentDisplay,
            );
            if (entered === undefined) return; // user cancelled
            const trimmed = entered.trim();
            if (trimmed === "" || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "clear") {
              nextList = [];
            } else {
              nextList = trimmed.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            }
          } else if (raw.toLowerCase() === "none" || raw.toLowerCase() === "clear") {
            nextList = [];
          } else {
            nextList = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
          }

          currentConfig.value = { ...currentConfig.value, protectedTools: nextList };
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Protected tools: ${protectedToolsDisplay(nextList)}`);
          break;
        }

        // ── /pruner min-batch-chars [value] ──
        // Bare form shows the current value. Numeric form sets it directly
        // (any non-negative integer accepted; not restricted to the preset
        // cycle exposed in the SettingsList). `0` disables the pre-flush
        // guard.
        case "min-batch-chars": {
          const arg = subArgs[0];
          if (!arg) {
            const cur = currentConfig.value.minBatchChars;
            const state = cur === 0 ? "disabled" : `${cur} chars`;
            ctx.ui.notify(`Current minBatchChars: ${state}.`);
            break;
          }
          const parsed = Number.parseInt(arg, 10);
          if (!Number.isFinite(parsed) || parsed < 0) {
            ctx.ui.notify(`Invalid minBatchChars: "${arg}". Expected a non-negative integer (0 disables).`, "warning");
            break;
          }
          currentConfig.value = { ...currentConfig.value, minBatchChars: parsed };
          saveConfig(currentConfig.value);
          ctx.ui.notify(
            parsed === 0
              ? "minBatchChars set to 0 — pre-flush trivial-batch skipping disabled."
              : `minBatchChars set to ${parsed}.`,
          );
          break;
        }

        // ── /pruner dedup [on|off|status] ──
        // Bare form shows current state; `on`/`off` flip and persist;
        // `status` is an explicit synonym for bare.
        case "dedup": {
          const arg = (subArgs[0] ?? "").toLowerCase();
          if (!arg || arg === "status") {
            const state = currentConfig.value.dedupByContentHash ? "ON" : "OFF";
            ctx.ui.notify(`Content-hash dedup is ${state}. ${dedupByContentHashDescription(currentConfig.value)}`);
            break;
          }
          if (arg !== "on" && arg !== "off" && arg !== "true" && arg !== "false") {
            ctx.ui.notify(`Invalid dedup value: "${arg}". Expected on, off, status, true, or false.`, "warning");
            break;
          }
          const next = arg === "on" || arg === "true";
          currentConfig.value = { ...currentConfig.value, dedupByContentHash: next };
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Content-hash dedup turned ${next ? "ON" : "OFF"}.`);
          break;
        }

        // ── /pruner help ──
        case "help":
          ctx.ui.notify(HELP_TEXT);
          break;

        // ── Unknown subcommand ──
        default:
          ctx.ui.notify(
            `Unknown subcommand: "${subcommand}". Run /pruner help for usage.`,
          );
      }
    },
  });

  // Register custom renderer for context-prune-summary messages
  pi.registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
    const details = message.details as {
      toolCallRefs?: { shortId: string; toolCallId: string }[];
      toolCallIds?: string[];
      turnIndex: number;
      toolNames: string[];
    };
    const turnIndex = details?.turnIndex ?? "?";
    const toolCount = normalizeSummaryToolCallRefs(details).length;
    const header = theme.fg("accent", `[pruner] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`);
    if (expanded) {
      return new Text(header + "\n" + message.content, 0, 0);
    }
    return new Text(header, 0, 0);
  });
}