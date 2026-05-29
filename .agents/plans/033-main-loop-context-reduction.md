---
name: 033-main-loop-context-reduction
description: |
  Extend pruning to the MAIN LOOP (not just closed chains), targeting main-loop thinking-block accumulation — the dominant cost in long single-agent sessions (observed ~80% of a 500K-token window). Two sequenced work items, A independently shippable before B.

  WORK ITEM A (ship first) — Rolling thinking-strip. A new deterministic, zero-LLM transform `stripOldThinking(messages, config)` keeps `thinking` blocks only on the last K assistant turns (default 16) and strips them (all-or-nothing, reusing `withoutThinkingBlocks`) from older assistant messages, preserving each message's `text` + `toolCall` blocks. Runs as Phase 4 of `pruner.ts` `pruneMessages`, AFTER chain-range-prune, over the surviving message array. Provider-safe because Anthropic only requires the LAST assistant turn's thinking during tool use (K>=1 guarantees it); prior turns are explicitly omittable. New config `thinkingStrip: { enabled, keepLastTurns }` with presets + settings-overlay rows + status note. Stripped thinking is NOT recoverable via context_tree_query (raw thinking stays in session JSONL on disk); drop-without-recovery is the recommended decision. Tests mirror chain-range-prune.test.ts. A is the high-leverage fix because it strips by assistant-turn age and does NOT depend on chains closing — exactly the one-long-open-chain failure mode.

  WORK ITEM B (follow-up) — Cohesive LLM range summaries for closed main-loop spans. The existing chain-compressor (`detectChains` + `selectEligible`/`compressEligible`, wired in `index.ts` `flushPending`) ALREADY segments the main branch at user-message boundaries and range-drops closed spans beyond `rollingWindow`, but its synthetic `<compressed-chain>` body is a concatenation of pre-existing per-batch summaries. B UPGRADES that body to a single cohesive LLM range summary (reusing `summarizer.ts`), so B is an evolution of chain compression, not a parallel system. Persistence reuses CUSTOM_TYPE_CHAIN with an added range-summary field. Automatic rolling-window trigger is primary; a model-driven trigger (extend `context_prune` tool / agentic-auto) + optional multi-turn span merging are an explicitly deferred sub-phase. Cache cost is higher than A (larger prefix rewrites + LLM calls) → cooldown/threshold guards.
steps:
  - phase: task-A1-config-types-and-presets
    steps:
      - "- [ ] proposal: subagent designs ThinkingStripConfig in src/types.ts, the thinkingStrip field on ContextPruneConfig, DEFAULT_CONFIG additions (enabled:true, keepLastTurns:16), and KEEP_LAST_TURNS_PRESETS; cites the existing ChainCompressionConfig/ROLLING_WINDOW_PRESETS patterns it mirrors"
      - "- [ ] review: reviewer validates field names, defaults match Section 6, preset values are string-typed for SettingsList cycling, keepLastTurns clamp rule (>=1) is specified"
      - "- [ ] apply: orchestrator edits src/types.ts only"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean"
  - phase: task-A2-thinking-strip-pure-transform
    steps:
      - "- [ ] proposal: subagent designs src/thinking-strip.ts `stripOldThinking(messages, config)` per Section 4 (count assistant turns like error-purge.ts; keep last K; strip all-or-nothing via withoutThinkingBlocks; same-reference no-op when nothing changes) and the bun:test suite per Section 8"
      - "- [ ] review: reviewer validates the keep-window is the last K ASSISTANT messages (not user-bounded spans), the most-recent assistant turn is always kept (provider floor), strip is all-or-nothing per message, idempotency + same-reference-on-no-op hold, no thinking-signature partial-strip"
      - "- [ ] apply: orchestrator adds src/thinking-strip.ts + src/thinking-strip.test.ts; re-exports withoutThinkingBlocks usage from chain-range-prune.ts"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/thinking-strip.test.ts` green"
  - phase: task-A3-pruner-and-context-hook-wiring
    steps:
      - "- [ ] proposal: subagent designs the pruner.ts Phase 4 insertion (run stripOldThinking AFTER chain-range-prune), the new `thinkingStrip?` param on pruneMessages, and the index.ts context-hook threading of currentConfig.value.thinkingStrip"
      - "- [ ] review: reviewer validates transform order (stub-replace -> error-purge -> chain-range-prune -> thinking-strip), the fast-path/no-op contract is preserved, master `enabled` gate unchanged"
      - "- [ ] apply: orchestrator edits src/pruner.ts + index.ts; extends src/pruner.test.ts with a thinking-strip composition case"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/pruner.test.ts` green"
  - phase: task-A4-commands-ui-and-status
    steps:
      - "- [ ] proposal: subagent designs the two SettingItem rows (thinkingStripEnabled toggle + thinkingStripKeepLastTurns cycle), their onChange branches, a thinkingStripDescription helper, and any status-widget mention; mirrors the chainCompression rows in src/commands.ts"
      - "- [ ] review: reviewer validates row ids/labels, onChange immutability pattern (spread config), preset fallback when persisted value isn't in the cycle, clamp >=1"
      - "- [ ] apply: orchestrator edits src/commands.ts"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; manual: `/pruner settings` shows the two rows and cycles them"
  - phase: task-A5-docs-smoke-and-release
    steps:
      - "- [ ] proposal: subagent drafts the PRUNING.md 'Main-loop thinking strip' section (algorithm + provider-safety citation + cache trade-off + drop-without-recovery rationale), README.md config-table rows, and AGENTS.md src/ layout row for thinking-strip.ts"
      - "- [ ] review: reviewer validates doc voice (terse, contract-first), provider-safety wording matches Section 5, no overclaiming of recovery"
      - "- [ ] apply: orchestrator edits PRUNING.md + README.md + AGENTS.md"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/` green; isolated PI_CODING_AGENT_DIR smoke run with a >16-assistant-turn single-span task; confirm context shrinks once turn 17 lands and the request still succeeds (no 400) on Opus/thinking; then run the release skill (minor bump)"
  - phase: task-B1-range-summarizer
    steps:
      - "- [ ] proposal: subagent designs `summarizeRange(...)` in src/summarizer.ts (serialize a closed span's assistant text + toolCall args + toolResults into one summarizer prompt; reuse resolveModel + stream + summarizerThinkingOptions), the span-serialization helper, and its failure/abort semantics mirroring summarizeBatch"
      - "- [ ] review: reviewer validates reuse of existing summarizer plumbing, that protectedTools content is excluded from the serialized span, and the no-summary refusal path"
      - "- [ ] apply: orchestrator adds summarizeRange + tests for the serialization helper"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/summarizer*.test.ts` green"
  - phase: task-B2-chain-entry-range-summary-and-synthetic-message
    steps:
      - "- [ ] proposal: subagent designs the CUSTOM_TYPE_CHAIN extension (add optional `rangeSummaryText` / `rangeSummaryRef`), the indexer rebuild change, and the buildSyntheticChainMessage change to prefer the LLM range summary over concatenated per-batch summaries when present (still substituteBlockRefs for {bN})"
      - "- [ ] review: reviewer validates backward-compat (old entries with no range summary still render via per-batch concat), idempotency of chain-range-prune is preserved, nested-placeholder substitution still applies"
      - "- [ ] apply: orchestrator edits src/types.ts + src/indexer.ts + src/chain-range-prune.ts; updates chain-range-prune.test.ts"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-range-prune.test.ts` green"
  - phase: task-B3-compressor-trigger-frontier-stats
    steps:
      - "- [ ] proposal: subagent designs the compressEligible change to call summarizeRange for each eligible span (with a per-span cooldown + minSpanChars guard analogous to minBatchChars), stats counters (rangesSummarized, range summarizer usage), and the index.ts flushPending wiring"
      - "- [ ] review: reviewer validates the LLM call is gated by rolling window + cooldown (cache-cost control), failures are non-fatal (fall back to per-batch concat), no double-summarization across reload"
      - "- [ ] apply: orchestrator edits src/chain-compressor.ts + src/stats.ts + index.ts; adds eligibility/cooldown unit tests"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-compressor.test.ts` green; smoke run shows a cohesive LLM range summary in a `<compressed-chain>` once a span ages out of the window"
  - phase: task-B4-docs-and-deferred-triggers
    steps:
      - "- [ ] proposal: subagent drafts the PRUNING.md 'Main-loop range summaries' section (delta vs chain compression, cache cost, cooldown), README rows, and an explicit 'Deferred' subsection naming the model-driven trigger (extend context_prune tool) + multi-turn span merging as future work with the open decisions restated"
      - "- [ ] review: reviewer validates the doc states B is an evolution of chain compression (not parallel), and the deferred items are clearly out of B's shipping scope"
      - "- [ ] apply: orchestrator edits PRUNING.md + README.md + AGENTS.md"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/` green; release skill (minor bump)"
  - phase: task-final-verification
    steps:
      - "- [ ] full typecheck: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`"
      - "- [ ] full test pass: `bun test src/`"
      - "- [ ] integration smoke (A): single-span session > keepLastTurns assistant turns on Opus/thinking=high; verify older-turn thinking stripped, request succeeds, context drops"
      - "- [ ] integration smoke (B): multi-span session; verify a cohesive LLM range summary appears in a compressed span once it ages past rollingWindow; verify context_tree_query still recovers the span's tool outputs"
      - "- [ ] AGENTS.md Project Layout + custom-entry table reflect thinking-strip.ts and any B range-summary entry changes"
      - "- [ ] no stale references; Open Questions section resolved or explicitly carried as deferred"
---

# 033 — Main-loop context reduction (thinking-strip → range summaries)

> **REQUIRED SUB-SKILL:** execute task-by-task via the repo `planning`/`executing-plans` flow (proposal → review → apply → verify per task), matching plan 032's pattern.

**Goal:** Give the pruner a way to reclaim **main-loop** context — primarily the accumulation of assistant `thinking` blocks — independent of subagent chains, with Work Item A (deterministic thinking-strip) shippable before Work Item B (cohesive LLM range summaries).

**Sequencing:** A → B. A is independently shippable (own minor release). B builds on the existing chain-compression plumbing and shares A's config/UI conventions.

---

## 0. Open Questions (resolve at the review gate before execution)

Each carries a **recommended default already baked into the plan**. Flag now if you disagree.

| # | Decision | Recommended default (baked in) | Why |
|---|---|---|---|
| Q1 | **A: recoverability of stripped thinking** | **Drop without recovery.** Not added to the indexer; not retrievable via `context_tree_query`. | Raw thinking remains in the session JSONL on disk (the `context` hook never mutates storage; see `index.ts` `pi.on("context")`). Thinking is transient model-internal reasoning, not an actionable artifact like a tool output. Indexing every assistant turn's thinking is large with no consumer. Matches the existing `chainCompression.stripFinalAssistantThinking`, which also drops thinking without recovery. |
| Q2 | **A: `thinkingStrip.enabled` default** | **`true`** (still gated behind master `enabled:false`). | `keepLastTurns:16` makes it a **no-op** for sessions under 16 assistant turns (zero churn, zero effect); it only activates on long sessions, which is the target. Consistent with `chainCompression.enabled` and `purgeErrors.enabled` both defaulting `true`. |
| Q3 | **A: "turn" unit + default K** | **Turn = one assistant message; `keepLastTurns:16`.** | The failure mode is ONE long open chain with near-zero user turns. A user-bounded-span unit (like `rollingWindow`) would keep everything in that case. Counting assistant messages directly targets the accumulation. K must be ≥1 (provider floor); 16 preserves recent reasoning continuity. |
| Q4 | **B: trigger model** | **Automatic (rolling window) ships in B; model-driven trigger is deferred.** | Automatic reuses the existing flush-time `compressEligible` path with zero new agent-facing surface. Model-driven (extend `context_prune` tool, agentic-auto) is additive and can land later without reworking B. |
| Q5 | **B: topic granularity** | **One span per closed main-loop chain (current `detectChains` unit). Multi-turn span merging is deferred.** | `detectChains` already emits exactly these spans. Merging adds a segmentation layer and ambiguity (where do merged topics start/end?) with unclear payoff. Ship the 1:1 mapping first. |
| Q6 | **B: persistence shape** | **Reuse `CUSTOM_TYPE_CHAIN`; add an optional `rangeSummaryText` field** (vs a brand-new entry type). | B is an evolution of chain compression, not a new system. One registry, one rebuild path in `indexer.reconstructFromSession`. Old entries with no range summary fall back to per-batch concat (backward compatible). |

---

## 1. Problem and goal

### 1.1 Observed failure mode

A long single-agent terraform/ops session (Opus, thinking=high) reached ~500K/1M tokens. By raw chars in the session JSONL:

| Component | ~tokens | Pruner reach today |
|---|---|---|
| Assistant `thinking` blocks (cleartext + signatures) | ~405K (~80%) | **None** |
| Tool results | ~104K | Stub-replaced (`pruner.ts` Phase 1) |
| Tool-call args | ~61K | Errored args only (`error-purge.ts` Phase 2) |
| Assistant text | ~22K | None |

### 1.2 Why the pruner was idle (grounded correction)

The brief states "zero subagents → chain compression had nothing to detect." Reading the source, the chain-compressor is **not** subagent-specific: `detectChains` (`src/chain-detector.ts`) walks the main message branch and emits a span for every `user → (assistant tool turns)* → text-only assistant`; `compressEligible` (`src/chain-compressor.ts`) compresses closed spans beyond `rollingWindow`. It already operates on the **main loop**.

The code-consistent explanation for idleness: an autonomous ops task is dominated by **one long in-flight chain** — the agent interleaves `text` + `toolCall` blocks in the same assistant message (so `hasToolCalls(msg)` is true and the chain never closes via a text-only turn) until the very end. `detectChains` drops open chains (`src/chain-detector.ts`: "Open chain at end of input is intentionally dropped"). With few/no **closed** spans, `selectEligible` has nothing beyond the window. Meanwhile thinking accumulates inside that single open span, untouched.

**Consequence for design:** the high-leverage fix must strip thinking **by assistant-turn age**, independent of whether any chain closes. That is Work Item A. Work Item B (cohesive range summaries) only helps once spans actually close, so it is the follow-up.

### 1.3 Goal

- **A:** deterministically evict old main-loop `thinking` while preserving `text` + `toolCall` and provider safety.
- **B:** when main-loop spans close and age out, replace them with a single cohesive LLM summary (DCP-style range mode), upgrading the existing chain compression body.

---

## 2. Existing primitives reused (cite before building)

| Primitive | File : symbol | Role in this plan |
|---|---|---|
| Context hook | `index.ts` : `pi.on("context", …)` | Both A and B render here via `pruneMessages`. Gated on `currentConfig.value.enabled`. |
| Prune composition | `src/pruner.ts` : `pruneMessages(messages, indexer, chainCompression?, errorPurge?)` | A adds Phase 4 (thinking-strip) here. |
| Thinking strip helper | `src/chain-range-prune.ts` : `withoutThinkingBlocks(msg)` | A reuses verbatim (all-or-nothing thinking removal, returns a copy). |
| Turn counting model | `src/error-purge.ts` : `purgeErroredArgs` | A copies its "count assistant messages, same-reference no-op" structure. |
| Main-loop segmenter | `src/chain-detector.ts` : `detectChains`, `withClosingMessage` | B reuses; this is the user-boundary segmentation the brief asks for — it already exists. |
| Eligibility + persistence | `src/chain-compressor.ts` : `selectEligible`, `compressEligible` | B extends to call the range summarizer. |
| Range drop + synthetic msg | `src/chain-range-prune.ts` : `applyChainCompressions`, `buildSyntheticChainMessage` | B swaps the synthetic body to the LLM range summary. |
| Nested summaries | `src/nested-placeholders.ts` : `substituteBlockRefs` | B keeps `{bN}` substitution in range summaries. |
| Block ids | `src/block-refs.ts` : `BlockRefIssuer` | B reuses for range block ids. |
| Summarizer | `src/summarizer.ts` : `resolveModel`, `summarizeBatch`, `summarizerThinkingOptions`, `serializeBatchForSummarizer` | B's `summarizeRange` reuses this plumbing. |
| Recovery | `src/query-tool.ts` : `context_tree_query`; `src/indexer.ts` : `getRecord` | B's span tool outputs already recoverable (their `CUSTOM_TYPE_INDEX` entries persist). A's thinking is intentionally NOT here (Q1). |
| Registry + rebuild | `src/indexer.ts` : `chainRegistry`, `getChainEntries`, `getPerBatchSummaryTextForToolCallIds`, `reconstructFromSession` | B extends entry shape + rebuild. |
| Config UI | `src/commands.ts` : settings `items[]` + `onChange`; `src/types.ts` presets | A and B add rows the same way `chainCompression*` rows are added. |
| Stats | `src/stats.ts` : `StatsAccumulator` (`chainsCompressed`) | B adds a `rangesSummarized` counter. |

---

## 3. Provider safety — the controlling contract (Anthropic)

Authoritative source: Anthropic "Extended thinking" docs (fetched) + pi-ai `node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js` + `providers/anthropic.js`.

1. **Only the LAST assistant turn is load-bearing.** "During tool use, you must pass thinking blocks back to the API for the last assistant message." Prior turns: "you **can omit** thinking blocks from prior assistant role turns" — "the API automatically filters the provided thinking blocks."
2. **All-or-nothing per message.** "the entire sequence of consecutive thinking blocks must match the outputs … you can't rearrange or modify the sequence." → strip a message's thinking **completely** or not at all. `withoutThinkingBlocks` already does this.
3. **Opus 4.5+/Sonnet 4.6+ keep ALL prior thinking by default** (older models strip to last turn). This is exactly why the terraform Opus session bloated — the client (pi-ai) replays every same-model thinking block (`transform-messages.js`: "keep thinking blocks with signatures … for replay"), and the server retains them. **Client-side strip is the only lever pi has** (the Anthropic-native `clear_thinking_20251015` context-editing strategy is not plumbed through pi and is Anthropic-only — rejected alternative).
4. **Interleaved thinking** is on by default in pi-ai (`anthropic.js`: `interleavedThinking ?? true`; Opus/Sonnet adaptive models have it built in). It does **not** add an in-cycle preservation requirement beyond rule 1: the docs' caching example shows that when prior thinking is absent the request "will be processed the same as" one with no prior thinking — no error.

**Derived safety rule for A:** keep thinking on the last **K ≥ 1** assistant turns. K=16 keeps far more than the floor and, in practice, the entire current in-flight cycle. The most-recent assistant turn is **always** retained (it is the last of the last-K), satisfying rule 1 even when the array tail is `… assistant[thinking,toolCall], toolResult` (awaiting continuation).

**Proof points already shipped:** `chainCompression.stripFinalAssistantThinking` strips the final text-only assistant's thinking, and `applyChainCompressions` drops entire middle tool-using assistant turns (with thinking+signatures) of closed chains — both accepted by Anthropic in 0.12.x. A generalizes the same operation by assistant-turn age.

---

## 4. Work Item A — algorithm (`src/thinking-strip.ts`, pure)

```ts
import type { ContextPruneConfig } from "./types.js";
import { withoutThinkingBlocks } from "./chain-range-prune.js";

// keepLastTurns counts ASSISTANT messages (assistant turns), not user-bounded spans.
// We keep thinking on the last K assistant turns and strip it from all older ones.
export function stripOldThinking(
  messages: any[],
  config: { enabled: boolean; keepLastTurns: number },
): any[] {
  if (!config.enabled) return messages;
  const keep = Math.max(1, config.keepLastTurns); // provider floor: never strip the last assistant turn

  // Pass 1: find indices of assistant messages; the last `keep` of them retain thinking.
  const assistantIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") assistantIdx.push(i);
  }
  if (assistantIdx.length <= keep) return messages; // nothing old enough → same reference

  const stripBefore = assistantIdx[assistantIdx.length - keep]; // first KEPT assistant index
  const stripSet = new Set(assistantIdx.filter((i) => i < stripBefore));

  // Pass 2: rewrite only the stripped assistant messages that actually carry thinking.
  let changed = false;
  const out = messages.map((msg, i) => {
    if (!stripSet.has(i)) return msg;
    const hasThinking = Array.isArray(msg.content) && msg.content.some((c: any) => c.type === "thinking");
    if (!hasThinking) return msg;
    changed = true;
    return withoutThinkingBlocks(msg);
  });
  return changed ? out : messages;
}
```

**Properties (mirroring `error-purge.ts` and `chain-range-prune.ts` contracts):**
- **Same-reference no-op** when `assistantIdx.length <= keep` or no stripped message carries thinking (lets `pruner.ts` skip reconstruction).
- **Ordering invariant:** map preserves order; only content of stripped assistant messages changes.
- **Idempotent:** a second pass finds the already-stripped messages have no thinking → no change.
- **All-or-nothing:** delegates to `withoutThinkingBlocks` (provider rule 2).
- **Provider floor:** `Math.max(1, keepLastTurns)` guarantees the last assistant turn keeps thinking (rule 1).

---

## 5. Work Item A — integration

### 5.1 Compose order in `pruner.ts`

`pruneMessages` currently runs: **[1] stub-replace → [2] error-purge → [3] chain-range-prune** (`src/pruner.ts`). A adds **[4] thinking-strip**, last.

```
raw event.messages
  → [1] stub-replace summarized toolResults        (per-message content)
  → [2] error-purge errored toolCall arg bodies     (per-message content)
  → [3] chain-range-prune closed spans > window     (structural drop/insert + final-assistant thinking strip)
  → [4] thinking-strip: keep thinking on last K assistant turns  (per-message content)
  → filtered messages → LLM
```

Run **last** so "last K assistant turns" is measured over the messages that actually survive to the LLM (after chain-range-prune drops old middle turns). The two strategies cooperate and never conflict: chain-range-prune removes old **closed-span bulk** (whole messages incl. their thinking); thinking-strip mops up thinking in the **surviving recent / in-flight** turns beyond K. In a no-closed-chain session (the failure mode), Phase 3 is a no-op and Phase 4 does all the work.

Signature change:
```ts
export function pruneMessages(
  messages: any[],
  indexer: ToolCallIndexer,
  chainCompression?: ChainCompressionConfig,
  errorPurge?: ErrorPurgeConfig,
  thinkingStrip?: ThinkingStripConfig,   // NEW
): { messages: any[]; pruned: boolean }
```
After Phase 3, if `thinkingStrip?.enabled`, call `stripOldThinking(current, thinkingStrip)`; if the returned array differs from `current`, set `current` and `pruned = true` (same pattern as Phases 2/3).

### 5.2 Context-hook threading in `index.ts`

In `pi.on("context")`, pass the new config:
```ts
const result = pruneMessages(
  messages, indexer,
  currentConfig.value.chainCompression,
  currentConfig.value.purgeErrors,
  currentConfig.value.thinkingStrip,   // NEW
);
```
No change to the master `enabled` gate or the `<pruner-note>` reminder path.

### 5.3 Cache trade-off (documented, not avoided)

Stripping the thinking of assistant turn `N-K` when turn `N` arrives changes the prefix at depth ~K from the end → prompt-cache invalidation from that point each new assistant turn (~K turns re-processed). The stable cached prefix (everything before turn `N-K`) still grows monotonically; only a K-deep tail churns.

Trade vs status quo on Opus 4.5+: **without** strip, all thinking is retained and billed as cached-input **forever** and the window eventually overflows (the actual 500K/1M failure). **With** strip, total context is bounded; the cost is a bounded per-turn tail rewrite — the same kind of prefix rewrite the rest of the extension already makes (PRUNING.md "Why Frequent Pruning Busts Cache"). Smaller K = less churn **and** more savings (only worse for reasoning continuity); larger K = more continuity, more churn. Default 16 balances. For sessions under K turns: literal no-op.

---

## 6. Work Item A — config schema (`src/types.ts`)

```ts
export interface ThinkingStripConfig {
  enabled: boolean;        // default true (Q2)
  /** Keep thinking on the last K assistant turns; strip older. Counts assistant messages. Min 1. Default 16. */
  keepLastTurns: number;   // default 16 (Q3)
}
```
Add to `ContextPruneConfig`:
```ts
  /** Rolling main-loop thinking-block strip: keep thinking only on the last K assistant turns. */
  thinkingStrip: ThinkingStripConfig;
```
Add to `DEFAULT_CONFIG`:
```ts
  thinkingStrip: { enabled: true, keepLastTurns: 16 },
```
Add presets (string-typed for `SettingsList` cycling, mirroring `ROLLING_WINDOW_PRESETS`):
```ts
export const KEEP_LAST_TURNS_PRESETS: { value: string; label: string }[] = [
  { value: "4", label: "4" },
  { value: "8", label: "8" },
  { value: "16", label: "16 (default)" },
  { value: "32", label: "32" },
  { value: "64", label: "64" },
];
```

### 6.1 `src/commands.ts` settings overlay (mirror the `chainCompression*` rows)

Two `SettingItem`s in `items[]`:
```ts
{
  id: "thinkingStripEnabled",
  label: "Thinking strip",
  values: ["true", "false"],
  currentValue: String(config.thinkingStrip.enabled),
  description: `Strip thinking blocks from assistant turns older than the last ${config.thinkingStrip.keepLastTurns}. Reclaims main-loop thinking accumulation. Currently ${config.thinkingStrip.enabled ? "ON" : "OFF"}.`,
},
{
  id: "thinkingStripKeepLastTurns",
  label: "Thinking keep (last N turns)",
  values: KEEP_LAST_TURNS_PRESETS.map((p) => p.value),
  currentValue: KEEP_LAST_TURNS_PRESETS.some((p) => p.value === String(config.thinkingStrip.keepLastTurns))
    ? String(config.thinkingStrip.keepLastTurns)
    : KEEP_LAST_TURNS_PRESETS[2].value, // fall back to "16"
  description: `Keep thinking on the last N assistant turns; strip older. Currently ${config.thinkingStrip.keepLastTurns}.`,
},
```
Two `onChange` branches (immutable spread + clamp, mirroring `chainCompressionRollingWindow`):
```ts
} else if (id === "thinkingStripEnabled") {
  newConfig.thinkingStrip = { ...newConfig.thinkingStrip, enabled: newValue === "true" };
} else if (id === "thinkingStripKeepLastTurns") {
  const parsed = Number.parseInt(newValue, 10);
  newConfig.thinkingStrip = {
    ...newConfig.thinkingStrip,
    keepLastTurns: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.thinkingStrip.keepLastTurns,
  };
}
```
Status widget: optional. `pruneStatusText` can append `· strip K=16` when `thinkingStrip.enabled`; not required for A.

---

## 7. Work Item A — recovery decision (Q1)

**Stripped thinking is dropped without recovery.**
- The session JSONL retains every original thinking block (the `context` hook only rewrites the in-flight `event.messages`; it never calls `appendEntry`/mutates storage).
- `context_tree_query` recovers **tool outputs** (`indexer.getRecord`), not assistant messages. Adding thinking to the index would mean persisting an index record per assistant turn (large) with no consumer and no recovery UX.
- Matches `chainCompression.stripFinalAssistantThinking` (drops thinking, no recovery).
- If a future need arises, recovery can be added later without reworking A (the raw data is still on disk).

PRUNING.md will state this explicitly so users know thinking is not `context_tree_query`-recoverable (unlike tool outputs).

---

## 8. Work Item A — test strategy (`src/thinking-strip.test.ts`, mirrors `chain-range-prune.test.ts`)

Reuse the helper-factory style (`userMsg`, `assistantWithTools`, `toolResult`, `assistantText(ts, includeThinking)` already in `chain-range-prune.test.ts`).

| Case | Assertion |
|---|---|
| disabled | `enabled:false` → same reference |
| fewer than K assistant turns | `assistantIdx.length <= keepLastTurns` → same reference, no strip |
| boundary: exactly K | the K-th-from-last assistant keeps thinking; the (K+1)-th strips |
| strips older, keeps last K | thinking removed on old assistant turns, present on the last K |
| last assistant turn always kept | with `keepLastTurns:1`, only the final assistant retains thinking (provider floor) |
| tool-use turn awaiting results at tail | array ending `… assistant[thinking,toolCall], toolResult`: that assistant (last) keeps thinking |
| preserves text + toolCall | stripped assistant still has its `text` and `toolCall` blocks; only `thinking` removed |
| all-or-nothing | an assistant with two thinking blocks loses both (no partial) |
| no thinking present | assistant turns without thinking → same reference |
| idempotency | second pass equals first |
| ordering invariant | output order identical to input |

Plus a `pruner.test.ts` composition case: with a summarized toolResult + a thinkingStrip config, both Phase 1 and Phase 4 fire and `pruned === true`.

---

## 9. Work Item B — design (cohesive LLM range summaries; evolves chain compression)

### 9.1 Delta vs existing chain compression

Existing chain compression (per closed span beyond `rollingWindow`): drops middle assistant turns + their toolResults, keeps the start user message, keeps the final text-only assistant (thinking stripped), injects a synthetic `<compressed-chain id="bN" tools="…">BODY</compressed-chain>` user message. **BODY today** = concatenation of pre-existing per-batch summaries (`indexer.getPerBatchSummaryTextForToolCallIds`) — no new LLM call.

**B changes only the BODY:** generate **one cohesive LLM range summary** of the whole span via `summarizer.ts`, used as the synthetic body (still passed through `substituteBlockRefs` for `{bN}` nesting). Everything else (drop/insert structure, recovery, idempotency, rolling window, persistence registry) is reused.

So B is **not** the brief's "new main-loop range compressor / new user-boundary segmenter" — those already exist (`chain-compressor` + `detectChains`). B is the summary-quality upgrade DCP calls range mode.

### 9.2 New/changed pieces

| Piece | File : symbol | Change |
|---|---|---|
| Range summarizer | `src/summarizer.ts` : `summarizeRange(span, config, ctx, opts)` (NEW) | Serialize a span (assistant `text` + `toolCall` args + `toolResult` text, excluding `protectedTools`) into one summarizer prompt; reuse `resolveModel` + `stream` + `summarizerThinkingOptions`; same abort/failure semantics as `summarizeBatch`. |
| Entry shape | `src/types.ts` : `ChainCompressionEntry` (Q6) | Add optional `rangeSummaryText?: string` (or `rangeSummaryRef?` to a stored summary message). |
| Rebuild | `src/indexer.ts` : `reconstructFromSession`, `registerChain` | Carry the new field through; no new `customType`. |
| Synthetic body | `src/chain-range-prune.ts` : `buildSyntheticChainMessage` | Prefer `entry.rangeSummaryText` when present; else fall back to per-batch concat (backward compatible). |
| Eligibility + LLM call | `src/chain-compressor.ts` : `compressEligible` | For each eligible span, call `summarizeRange`; guard with a per-span **cooldown** + `minSpanChars` (analog of `minBatchChars`); on failure, fall back to per-batch concat (non-fatal). |
| Stats | `src/stats.ts` : `StatsAccumulator` | Add `rangesSummarized` + fold range summarizer usage into existing token/cost totals via `add`. |
| Wiring | `index.ts` : `flushPending` chain-compression block, `compactChains` | Pass the model/ctx so `compressEligible` can summarize; keep non-fatal try/catch. |

### 9.3 Protections (reuse, restate)

- **In-flight / incomplete spans never compressed:** `detectChains` drops open chains; `selectEligible` requires `finalAssistantTimestamp !== null`.
- **User messages preserved as boundaries:** start user message kept raw; synthetic inserted after it (`applyChainCompressions`).
- **protectedTools:** excluded from the serialized span (same filter used at capture in `index.ts` `turn_end`).
- **Recovery:** the span's tool outputs remain in `CUSTOM_TYPE_INDEX` → `context_tree_query` still works (no change needed). The raw span text/thinking remain in the session JSONL.

### 9.4 Cache cost (higher than A → guards)

A range LLM summary + dropping a whole span rewrites the prefix from that span's start. Mitigations, all reusing existing patterns:
- Only fire beyond `rollingWindow` (decisions happen at predictable flush boundaries, not every turn — same as today).
- **Cooldown** before summarizing a freshly-closed span (avoid summarizing a span the model may still revisit) + `minSpanChars` floor (don't pay an LLM call for a tiny span).
- LLM failure is non-fatal: fall back to the existing per-batch concat body so a compression still happens.

### 9.5 Deferred sub-phase (explicitly out of B's shipping scope)

- **Model-driven trigger (Q4):** extend `context_prune` (`src/context-prune-tool.ts`) so the agent can request a range compression of a just-closed sub-task (DCP's model-driven philosophy), active in `pruneOn: "agentic-auto"`. The scaffolding (`AGENTIC_AUTO_SYSTEM_PROMPT`, tool activation in `index.ts` `syncToolActivation`) already exists.
- **Multi-turn span merging (Q5):** merge several consecutive closed spans into one topic summary. Requires a merge segmenter on top of `detectChains`.

Both are additive; neither requires reworking B's automatic path.

### 9.6 B test strategy

- `summarizeRange` serialization helper: pure unit tests (span → prompt; protectedTools excluded; empty span guarded).
- `compressEligible` cooldown/minSpanChars eligibility: unit tests (`< window`, `== window`, `> window`, within cooldown, below minSpanChars).
- `buildSyntheticChainMessage`: prefers `rangeSummaryText` when set; falls back to concat when absent (backward compat); `{bN}` substitution still applies; idempotency preserved (extend existing `chain-range-prune.test.ts`).
- Integration smoke: multi-span session; once a span ages past `rollingWindow`, the `<compressed-chain>` body is the cohesive LLM summary; `context_tree_query` recovers the span's tool outputs.

---

## 10. Files

**Create (A):** `src/thinking-strip.ts`, `src/thinking-strip.test.ts`
**Modify (A):** `src/types.ts` (ThinkingStripConfig, field, DEFAULT_CONFIG, KEEP_LAST_TURNS_PRESETS), `src/pruner.ts` (Phase 4 + param), `index.ts` (thread config), `src/pruner.test.ts` (composition case), `src/commands.ts` (2 rows + 2 onChange), `PRUNING.md` (Main-loop thinking strip section), `README.md` (config rows), `AGENTS.md` (Project Layout row)

**Modify (B):** `src/summarizer.ts` (`summarizeRange` + serialization helper + tests), `src/types.ts` (`rangeSummaryText` field), `src/indexer.ts` (carry field through rebuild), `src/chain-range-prune.ts` (`buildSyntheticChainMessage` body source) + test, `src/chain-compressor.ts` (LLM call + cooldown/minSpanChars guards) + test, `src/stats.ts` (`rangesSummarized`), `index.ts` (`flushPending`/`compactChains` wiring), `PRUNING.md` + `README.md` + `AGENTS.md`

**Delete:** none. **New `customType`:** none (B reuses `CUSTOM_TYPE_CHAIN`).

---

## 11. What this does NOT do

- **No partial thinking strip** (provider rule 2) and **no stripping the last assistant turn** (rule 1).
- **A: no recovery of stripped thinking** (Q1) — raw stays in session JSONL; not in the index.
- **No Anthropic-native `clear_thinking` context-editing** — not plumbed through pi; client-side strip is provider-agnostic and fits pi's `context` hook.
- **No cross-model thinking handling** — pi-ai `transform-messages.js` already converts/drops cross-model thinking before our transform runs.
- **B: no model-driven trigger and no multi-turn span merging in the shipping scope** (Q4/Q5) — deferred sub-phase.
- **B: no new persistence entry type** (Q6) — extends `CUSTOM_TYPE_CHAIN`.

---

## 12. Verification (per AGENTS.md)

- Typecheck: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
- Tests: `bun test src/`
- A smoke: isolated `PI_CODING_AGENT_DIR`, a single-user-message task that runs **> keepLastTurns** assistant turns on Opus with thinking=high; confirm (1) the request succeeds (no 400 — provider safety), (2) older-turn thinking is gone from the next request, (3) the window stops growing. Inspect entries: `jq -r 'select(.type=="custom" or .type=="custom_message") | .customType' session.jsonl | sort | uniq -c`.
- B smoke: multi-span task; once a span ages past `rollingWindow`, confirm the `<compressed-chain>` body is the cohesive LLM summary and `context_tree_query` recovers the span's tool outputs.
- Releases: A ships as its own minor bump (release skill); B as a later minor bump.
