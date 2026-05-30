---
title: Protected-tool chain safety, empty-summary guard, typecheck fix, token-budget auto-flush
date: 2026-05-30
status: draft
branch: protected-chain-budget
worktree: .worktrees/protected-chain-budget
supersedes: untracked .agents/plans/034-protectedTools-dedup-pending-fixes.md (deleted)
---

# Summary

Four changes shipped together. Three are correctness/hygiene fixes surfaced by the DCP-parity
review; one is an opt-in feature (default-off).

| # | Item | Type | Default behavior change |
|---|---|---|---|
| 1 | `protectedTools` × chain compression: relocate protected outputs into the compressed-chain body instead of dropping them | correctness | none (only fires when `protectedTools` non-empty) |
| 2 | Empty / truncated summary soft-fail guard | correctness | none (only changes the empty/`length` failure path) |
| 3 | Test fixtures `fuseRangeSummary` typecheck fix | hygiene | none |
| 4 | Token-budget auto-flush (`autoBudgetThreshold`) | feature, opt-in | none (`null` = off) |

**Regression invariant for the whole release:** with default config
(`protectedTools: []`, `autoBudgetThreshold: null`) every code path below is inert and behavior
is byte-identical to today. Items 1 and 4 only activate on explicit opt-in. Item 2 only changes
behavior when the summarizer returns empty or truncated text (today a latent bug). Item 3 is
test-only.

Dropped from the original review scope: the `selectEligible` "no-summary blocks next-oldest"
claim (false positive — the loop `continue`s past no-summary chains and processes all remaining
eligible chains; `chain-compressor.ts:88-95`), and the content-hash dedup normalization /
args-blind concerns (downgraded to Minor; tracked separately, not in this release).

---

# Item 1 — protectedTools × chain compression

## Problem (confirmed against source)

`protectedTools` is an allowlist of tool names whose outputs must never be pruned
(`types.ts` `ContextPruneConfig.protectedTools`, doc-comment: "outputs must NEVER be pruned or
summarized"). Enforced at capture time: `turn_end` filters them out of the `CapturedBatch`
(`index.ts:710-722`) so they are **never indexed** and stay verbatim in context.

Chain range-compression violates this:

1. `detectChains` adds **every** middle `toolCallId` to `ChainRange.middleToolCallIds`, protected
   included (`chain-detector.ts:62-71`).
2. `compressEligible` sets `entry.droppedToolCallIds = chain.middleToolCallIds` with no protection
   filter (`chain-compressor.ts:118`). The eligibility gate `hasPerBatchSummaryCoveringAny`
   passes whenever **any one** sibling tool in the chain was summarized
   (`chain-compressor.ts:92`), so a mixed chain (≥1 summarized + ≥1 protected) is eligible.
3. `applyChainCompressions` drops any `toolResult` whose id ∈ `droppedToolCallIds`
   (`chain-range-prune.ts:79`).

Because protected outputs are never indexed, a dropped protected output is **unrecoverable** via
`context_tree_query`. Trigger: `protectedTools` non-empty (e.g. the documented `todowrite`/
`todoread`) + `chainCompression.enabled` (default on). Default `protectedTools: []` masks it
out-of-box, but the documented opt-in breaks the contract.

## Why not the obvious fix (skip mixed chains — rejected "Approach C")

Skipping any chain that contains a protected tool would forfeit a large fraction of compaction for
exactly the users who enable the feature: a chain is `[user] → [tool turns…] → [text]`
(`chain-detector.ts:30`), i.e. usually a whole task, and high-frequency protected tools
(`todowrite`/`todoread`/`edit`) recur throughout most tasks. Most chains would become ineligible.
Rejected.

Also rejected — "Approach B1" (exclude protected ids from `droppedToolCallIds`, keep the protected
turn in place): a mixed assistant turn that calls both a protected and a non-protected tool is
dropped as a whole (`chain-range-prune.ts:84-87` drops the assistant message if *any* of its
toolCall ids is dropped), which would orphan the surviving protected `toolResult` (no matching
`toolCall`). pi-ai's `insertSyntheticToolResults` repairs orphaned *calls*, not orphaned
*results*, so this risks breaking role alternation.

## Design (chosen — "Approach B", DCP-faithful: relocate)

Keep the contiguous range-drop exactly as today (protected ids stay in `droppedToolCallIds`, so the
protected `toolResult` and its assistant turn drop cleanly — no orphans, no alternation risk), but
**relocate** the protected outputs' verbatim text into the synthetic `<compressed-chain>` body.

Protected outputs are never indexed, but the `context` event always re-runs `pruneMessages` on the
**raw branch** (session is never mutated), so the protected `toolResult` is always present at render
time. Therefore the verbatim text is pulled live from `messages` during
`applyChainCompressions` — nothing large is persisted in the entry (only the id list).

### Data model change

`ChainRange` (detection-time, `types.ts`): add

```ts
/** Subset of middleToolCallIds whose tool name ∈ protectedTools (detection-time fact). */
protectedToolCallIds: string[];
```

`ChainCompressionEntry` (persisted, `types.ts`): add

```ts
/**
 * Subset of droppedToolCallIds whose tool was user-protected. Membership is decided
 * per call by tool name (every call whose name ∈ protectedTools), not a per-id allowlist —
 * so every todowrite call in the chain is captured regardless of its id. Their verbatim
 * ToolResultMessage text is relocated into the synthetic <compressed-chain> body
 * at render time (pulled live from the raw branch) instead of being dropped.
 * Absent/empty ⇒ no protected outputs in this chain (identical to pre-feature behavior).
 */
protectedToolCallIds?: string[];
```

### Code changes

1. **`src/chain-detector.ts`** — `detectChains(messages, protectedTools: string[] = [])`:
   - Build a `Set<string>` from `protectedTools`.
   - While collecting middle ids, also record protected ones. The assistant branch has
     `b.name`+`b.id` (`collectToolCallIds` currently drops the name); the toolResult branch has
     `msg.toolName`+`msg.toolCallId`. Track a per-chain `protectedIds: Set<string>` alongside
     `middleIds` and populate from both branches when the name is in the protected set.
   - Emit `protectedToolCallIds: [...protectedIds]` on every `ChainRange` (including the
     `emitInterrupted` path). Default param `[]` ⇒ always empty ⇒ current behavior.

2. **`src/chain-compressor.ts`** — `compressEligible`:
   - Copy `protectedToolCallIds` from the `ChainRange` onto the `ChainCompressionEntry`
     (`...(chain.protectedToolCallIds?.length ? { protectedToolCallIds: chain.protectedToolCallIds } : {})`).
   - `droppedToolCallIds` is unchanged (still `chain.middleToolCallIds`, protected included).
   - No new dependency: names were resolved in the detector; the compressor only forwards ids.

3. **`src/chain-range-prune.ts`** — `applyChainCompressions` + `buildSyntheticChainMessage`:
   - Before the rebuild loop, build `protectedTextByBlock: Map<blockId, {tool: string; text: string}[]>`
     by scanning `messages` once: for each `toolResult` whose `toolCallId` is in some entry's
     `protectedToolCallIds`, push `{ tool: msg.toolName, text: extractToolResultText(msg) }` under
     that entry's `blockId`. Preserve message order.
   - `buildSyntheticChainMessage` gains a `protectedOutputs: {tool; text}[]` param. Render each as a
     verbatim block appended after the (substituted) summary, inside the `<compressed-chain>` tag:

     ```
     <compressed-chain id="b7" tools="t1,t2">
     {resolvedSummary}

     <protected-output tool="todowrite">
     {verbatim text}
     </protected-output>
     </compressed-chain>
     ```

     No `id=` attribute on `<protected-output>` (not recoverable via `context_tree_query` — must not
     look queryable). Empty `protectedOutputs` ⇒ no block ⇒ byte-identical to today's render.
   - Protected `toolResult`s are still dropped by the existing `droppedToolCallIds` filter — the
     relocation does not change the drop set.

4. **`src/batch-capture.ts`** — extract the inline toolResult text logic (lines 28-38) into an
   exported `extractToolResultText(msg): string` and reuse it in both `captureBatch` and
   `chain-range-prune` so the relocated text is identical to what capture would have produced.

5. **`index.ts`** — pass `currentConfig.value.protectedTools` to both `detectChains` call sites
   (`:521` flush path via `withClosingMessage`, `:859` `/pruner compact`).

6. **Session rebuild** — confirm the `session_start` rebuild that replays `CUSTOM_TYPE_CHAIN`
   entries into the chain registry preserves the new optional `protectedToolCallIds` (it should, if
   it stores the entry as-is; verify in `indexer.ts` `registerChain` / rebuild and add coverage).

### Edge cases

- **Chain of only protected tools** (no summarizable sibling): `hasPerBatchSummaryCoveringAny`
  returns false (protected tools are never summarized) ⇒ chain ineligible ⇒ never compressed.
  Naturally safe; no special-casing.
- **Protected toolResult missing at render** (truncated/edited history): skip that id (best-effort);
  the rest of the chain still compresses.
- **Protected tool's call args** (in the assistant `toolCall` block) are dropped with the turn. The
  contract protects *outputs*, not call args (matches DCP). Documented, not preserved. The relocated
  block is labeled `<protected-output tool="name">`; the feature targets self-describing state tools
  (`todowrite`/`todoread`) whose output stands alone. Protecting a tool whose output is meaningless
  without its args (e.g. `read_file`, where the path lives in the args) is a misuse, not a goal of
  this release.
- **Large protected outputs** inflate the synthetic message. Inherent to "keep verbatim" — net
  context size is comparable to leaving the raw `toolResult` in place. No size guard in this release.
- **`protectedTools` changed after compression**: the entry's `protectedToolCallIds` is fixed at
  compression time, so already-compressed chains keep their relocation regardless of later config
  edits. Correct and stable — by design.

---

# Item 2 — empty / truncated summary guard

## Problem (confirmed)

`runSummarization` (`summarizer.ts:171-180`) returns `{ summaryText: llmText, usage }` where
`llmText` is the joined text blocks. Two unsafe cases pass through:

- **Empty text** (e.g. a reasoning model emits only `thinking`, no `text`): `llmText === ""`. In
  `flushPending`, `summaryText = "" + formatSummaryToolCallRefs(refs)` (footer only),
  `shouldSkipOversized = footer.length > batchRawCharCount` is usually false ⇒ the footer-only
  "summary" is injected and the raw batch is pruned behind it (`index.ts:393-394`).
- **Truncated** (`response.stopReason === "length"`): currently unhandled (only `aborted`/`error`
  are; `summarizer.ts:159-166`) ⇒ a partial summary is treated as complete.

## Design

Treat both as a **soft failure** (return `null`). `flushPending` already maps a `null` per-batch
result to `firstFailureIndex` → `restoreBatches(...)`, keeping the raw batch in context
(`index.ts:431-447`), and reports `summarizer-failed` only if nothing processed. This is the exact
desired behavior — no raw pruned behind a useless summary, retried next flush.

### Code change (`src/summarizer.ts`)

Extract a pure decision helper for testability and wire it into `runSummarization` after computing
`llmText`:

```ts
/** A summary is usable only if it has non-whitespace text and was not truncated. */
export function isUsableSummary(llmText: string, stopReason: string): boolean {
  return llmText.trim().length > 0 && stopReason !== "length";
}
```

In `runSummarization`, after building `llmText`:

```ts
if (!isUsableSummary(llmText, response.stopReason)) return null;
```

Both the per-batch (`summarizeBatch`) and range-fusion (`summarizeRange`) callers already handle
`null`: range fusion falls back to per-batch concatenation (`chain-compressor.ts:104-112`), per-batch
restores the batch. No caller changes needed.

---

# Item 3 — test fixtures typecheck fix

## Problem (confirmed)

`fuseRangeSummary` is a required field of `ChainCompressionConfig` (`types.ts`), but two test
fixtures omit it:

- `src/pruner.test.ts:31` → TS2741
- `src/pruner.test.ts:299` → TS2345

Runtime tests pass (the field is unread by those cases), but the repo does not typecheck. AGENTS.md
mandates a clean `tsc` before commit.

## Design

Set `fuseRangeSummary: false` on both literals (concrete, no runtime effect):
- `:31` is the shared `enabledCC` const — these tests pass no `fuseRange` dep and assert no fusion, so `false` keeps behavior.
- `:299` is an inline literal with `enabled: false`, so the value is inert.

Two-line change.

**Done-when:** the AGENTS.md typecheck command runs clean across the whole repo **including tests**:

```
bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict \
  --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node \
  index.ts src/*.ts src/*.test.ts
```

---

# Item 4 — token-budget auto-flush (opt-in)

## Motivation + DCP lineage

DCP nudges/compresses when context approaches `maxContextLimit`. This fork only triggers flushes on
turn/agent-message/context-tag boundaries — a long task can pile up raw tool output and approach the
context limit *between* flush boundaries (e.g. many tool turns before the final text response in
`agent-message` mode). A single opt-in threshold closes that gap: when context usage crosses the
threshold, flush the pending batches immediately regardless of `pruneOn`.

## Design

### Config (`src/types.ts`)

Add to `ContextPruneConfig`:

```ts
/**
 * Token-budget auto-flush trigger. When set to a fraction in (0, 1] (a 0–1 share of the
 * context window, NOT a 0–100 percentage; e.g. 0.8 = flush at 80% of the window), a flush of all
 * pending batches is forced at the end of any tool-using turn once context usage
 * (tokens / contextWindow) reaches the threshold — regardless of `pruneOn`. This is an
 * ADDITIONAL trigger layered on top of `pruneOn`, not a replacement; it lets long tasks
 * compact before hitting the context limit instead of waiting for the next flush boundary.
 *
 * null (default) = disabled, exactly preserving pre-feature behavior. Out-of-range values
 * (<= 0 or > 1) are treated as disabled.
 */
autoBudgetThreshold: number | null;
```

`DEFAULT_CONFIG.autoBudgetThreshold = null`.

### Pure helper (`src/budget.ts`, new)

```ts
import type { ContextUsage } from "@mariozechner/pi-coding-agent";

/**
 * True iff a budget-triggered flush should fire. Computes the ratio ourselves
 * (tokens / contextWindow, a 0–1 fraction) rather than ContextUsage.percent (a 0–100 value,
 * null when tokens is null). tokens is also null right after a compaction — guarded below.
 */
export function shouldBudgetFlush(usage: ContextUsage | undefined, threshold: number | null): boolean {
  if (threshold == null || threshold <= 0 || threshold > 1) return false;
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return false;
  return usage.tokens / usage.contextWindow >= threshold;
}
```

(`ContextUsage` = `{ tokens: number | null; contextWindow: number; percent: number | null }`,
verified in `@mariozechner/pi-coding-agent` types. `getContextUsage(): ContextUsage | undefined` is
on `ExtensionContext`.)

### Trigger wiring (`index.ts`, `turn_end`)

At the **tail** of the `turn_end` handler (after the existing `pruneOn` dispatch block, ~`:755`):

```ts
if (
  currentConfig.value.pruneOn !== "every-turn" &&
  shouldBudgetFlush(ctx.getContextUsage?.(), currentConfig.value.autoBudgetThreshold) &&
  !isFlushing
) {
  const before = pendingBatches.length;
  if (before > 0) {
    safeNotify(ctx, `pruner: context budget reached — compacting ${before} pending turn(s)`, "info");
    await flushPending(ctx, { delivery: "session" });
  }
}
```

Notes:
- `every-turn` already flushed above ⇒ excluded (no double flush).
- `isFlushing` (existing guard, `index.ts:63`) makes this race-safe; `flushPending` also re-checks
  and returns `already-flushing`.
- Budget flush only summarizes **completed** turns' pending batches. The current open chain is not
  closed here (the detector drops open chains), so chain compression is untouched mid-task — only
  per-batch summarization runs. Safe.
- Guarded on `before > 0` so a hot-but-empty queue (everything already pruned) is a no-op.

### Settings surface (`src/commands.ts`, `src/config.ts`)

- `config.ts`: normalize/clamp on load — coerce non-number/out-of-range to `null`.
- `commands.ts`: add a cycling preset to the `/pruner` settings overlay and a
  `AUTO_BUDGET_PRESETS` list in `types.ts`:

  ```ts
  export const AUTO_BUDGET_PRESETS: { value: string; label: string }[] = [
    { value: "0",    label: "Off (default)" },
    { value: "0.6",  label: "60%" },
    { value: "0.7",  label: "70%" },
    { value: "0.8",  label: "80%" },
    { value: "0.9",  label: "90%" },
  ];
  ```

  `"0"` is the disabled sentinel (maps to `null`), consistent with `minBatchChars`'s `"0"` pattern.

---

# Documentation deliverables (required — feature must be well-documented)

| File | Addition |
|---|---|
| `src/types.ts` | Doc-comments on `autoBudgetThreshold` (units = fraction 0–1, `null`=off, out-of-range=off) and on the two new `protectedToolCallIds` fields (already specified above). |
| `README.md` | New config-table row for `autoBudgetThreshold`. New subsection **"Token-budget auto-flush"**: what it does, default off, fraction semantics (`0.8` = 80% of the window, not `80`), that it's *additional* to `pruneOn`, the `tokens==null`-after-compaction caveat, and the `/pruner` setting. One line in the protectedTools section noting protected outputs are now preserved (relocated into the compressed-chain block) when their chain is compressed. |
| `PRUNING.md` | Short subsection: budget trigger as an additional flush trigger orthogonal to `pruneOn`, why we compute `tokens/contextWindow` as a 0–1 fraction (percent is 0–100 and null when tokens is null; tokens is null right after compaction), and the DCP `maxContextLimit` lineage. Update the chain-compression section to document protected-output relocation (Approach B) and why skip-the-chain (C) was rejected. |
| `AGENTS.md` | Update the `CUSTOM_TYPE_CHAIN` row to note the entry now carries optional `protectedToolCallIds`. |

---

# Testing strategy

All pure-unit where possible; existing 108 tests must stay green and `tsc` must be clean.

| Item | Test | Key cases |
|---|---|---|
| 1 | `chain-detector` | `protectedTools` populates `ChainRange.protectedToolCallIds` for both assistant-call and toolResult branches; empty/omitted ⇒ `[]`; interrupted-chain path also populated. |
| 1 | `chain-range-prune` | Mixed chain: non-protected results dropped + summarized, protected result dropped from position **and** rendered verbatim inside `<compressed-chain>` under `<protected-output tool="…">`; pure chain (no protected) renders byte-identical to pre-change; idempotent across two passes; protected id missing from messages ⇒ skipped, rest compresses; relocated `<protected-output>` is NOT registered in the tool-call index ⇒ not recoverable via `context_tree_query` and carries no queryable id. |
| 1 | `chain-compressor` | `protectedToolCallIds` copied from range onto entry; all-protected chain stays ineligible (no per-batch summary). |
| 1 | session rebuild | `CUSTOM_TYPE_CHAIN` replay preserves `protectedToolCallIds`. |
| 2 | `summarizer` (new file) | `isUsableSummary`: empty/whitespace ⇒ false; `stopReason==="length"` ⇒ false; normal ⇒ true. (summarizer.ts currently has zero tests.) |
| 3 | n/a | `tsc` clean across `index.ts src/*.ts src/*.test.ts`. |
| 4 | `budget` (new file) | `shouldBudgetFlush`: `null`/`0`/`>1` threshold ⇒ false; `usage` undefined ⇒ false; `tokens==null` ⇒ false; `contextWindow<=0` ⇒ false; exactly-at ⇒ true; over ⇒ true; under ⇒ false. |

**Done-when:** new + existing tests green (`bun test`); `tsc` clean; manual smoke per AGENTS.md
(`pi -e ./index.ts …` against an isolated `$PI_CODING_AGENT_DIR`) confirming (a) a protected-tool
output survives a chain compression inside the synthetic block, and (b) setting
`autoBudgetThreshold` forces an early flush.

---

# Implementation order

The four items are **mutually orthogonal** — no shared runtime path and no shared mutable test
state. Specifically, Item 4's budget trigger flushes pending per-batch summaries on `turn_end` and
**never invokes chain compression** (chains only close on `message_end`), so Item 1's protected-output
relocation does not affect Item 4's behavior or its tests. There is therefore no hard ordering
requirement.

Recommended commit/PR sequence for **review hygiene only** (not a dependency): #3 (typecheck — makes
the repo green immediately) → #2 (empty-summary guard) → #1 (protected-tool relocation) → #4
(token-budget). Each can land and be tested in isolation.

---

# Out of scope

- Content-hash dedup normalization / args-blind keying (Minor; separate follow-up).
- `selectEligible` change (withdrawn false positive).
- DCP parity items deliberately deferred (not regressions — features we don't yet have):
  `turnProtection`, `protectedFilePatterns`, `protectTags` (DCP's `<protect>` content tags),
  `/pruner decompress|recompress`, `focus` param on the compress tool, message-mode compression.
- DCP `protectUserMessages`: N/A in this harness — this extension never prunes user messages (only
  tool results and assistant turns), so user messages are already always preserved.
- Size guard on relocated protected outputs (revisit only if large protected outputs bloat context
  in practice).
