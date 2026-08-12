# Single-chain observability + reload trigger repair (issue #6)

Implements [jjuraszek/pi-condense#6](https://github.com/jjuraszek/pi-condense/issues/6): long single-chain sessions expose two compounding gaps - no observability into what the pruner *cannot* see (open-cycle thinking, chain dominance, frontier gap), and reloads discarding the in-memory `pendingBatches` queue, which strands the automatic flush trigger even though the branch-rescan data path could recover the work.

Issue AC 2, verbatim: "`/pruner status` + footer show open-cycle thinking, largest-chain share, frontier gap; a session entry records them per flush." All three metrics therefore appear on both surfaces.

## Incident summary (evidence basis)

Real 1M-window session, 256 assistant turns, ~5h, single chain (zero mid-run text-only assistant replies, so the `agent-message` flush boundary never fired). `autoBudgetThreshold` 0.8 never crossed (peak 53.7%). Result: ~195k tokens of raw toolResults never summarized; `/pruner status` showed `calls: 1, input: 3 tokens`.

**AC 1 disposition (user decision):** the incident JSONL is gone. AC 1 is downgraded to source-level verification, which is complete:

- The flush data path is reload-safe: `capturePendingBatches` (`index.ts:138-152`) rescans the persisted branch via `captureUnindexedBatchesFromSession` (`src/batch-capture.ts:69-145`), occurrence-key-filters against the indexer, and trims at the frontier. Captured-but-unflushed work is always recoverable from the session.
- The flush *trigger* is not: `pendingBatches` is zeroed on `session_start` (`index.ts:679`) and `session_tree` (`index.ts:709`). The `turn_end` handler returns early when the turn has no toolResults or when trim leaves no batch (`index.ts:719-724`, `764`), so the budget gate at `index.ts:794` is only ever reached with a freshly pushed batch - after a reload, no path evaluates the budget trigger against the recoverable work until a *new* unprotected toolResult turn arrives. The `agent_end` pending-notify (`index.ts:823-825`) is likewise silent when the in-memory queue is empty.
- The "nothing pending" `/pruner now` report from the incident is **an accepted unknown** - trigger loss alone does not explain it, and without the JSONL it cannot be investigated further. Recorded here so a future recurrence has a named prior (the per-attempt flush-metrics entries in Component 3 exist precisely to make a recurrence diagnosable).

## Goals

1. **Metrics (AC 2):** three new observability metrics, surfaced in `/pruner status`, the footer widget, and a per-flush-attempt session entry.
2. **Trigger repair (AC 3):** after a reload with recoverable work on the branch, the budget/delta trigger fires on the next `turn_end` - including turns that contribute no new batch - and the recoverable work is visible at `agent_end` and in `/pruner status`. Reload followed by total idleness (no further turns at all) remains visibility-only by design (no flush at boot).
3. **Docs (AC 4):** PRUNING.md documents the single-chain limitation of Phase 3 as a known design property, with config guidance.
4. **No `cost:external` change (AC 5):** satisfied by non-action; the payload and emission points are untouched.

## Out of scope (roast-killed in the issue; restated as binding)

- No new pruning valve of any kind (forced-close/reopen, stub-replace-inside-recent-chain, cycle-closing via toolResult mutation, thinking stripping). NO-GO pending a corpus replay this change does not authorize.
- No executor-behavior fixes (upstream cause shipped in pi-gauntlet v4.7.0, jjuraszek/pi-gauntlet#6).
- No queue reconstruction on reload - the repair is a trigger flag over the existing branch-rescan data path.
- No immediate flush on `session_start`/`session_tree` (no LLM call at boot; print-mode sessions may die under it; compacts work the user did not ask to compact yet).

## Design

### Component 1: metrics module (`src/context-metrics.ts`, pure)

One pure function computing a snapshot from a branch (`AgentMessage[]`, the raw unwrapped `type === "message"` projection of `getBranch()` - measuring what is persisted, not the post-prune in-flight context), the persisted frontier, a summarized-predicate, and a protection predicate:

```ts
interface ContextMetricsSnapshot {
  openCycleThinkingTokens: number;  // est. tokens of thinking blocks retained in the trailing open segment
  largestChainSharePct: number;     // max(largest closed chain, open segment) chars / total branch chars, 0-100
  frontierGapTokens: number;        // est. tokens of summarization-eligible unsummarized toolResults after the frontier
}
computeContextMetrics(branch, frontier: PruneFrontier | null, isSummarized, isProtected): ContextMetricsSnapshot
```

**Measurement convention (one convention for everything in this module):** per-message chars = `JSON.stringify(message).length`; tokens = `Math.round(chars / 4)`. This matches the reclaim footer's basis (`src/commands.ts:76-77`); the `Math.ceil` used by the compact preview (`src/commands.ts:1032`) is not adopted. Numerator and denominator of the share metric use this same basis.

**Open segment:** the message range strictly after the last text-only assistant message (assistant with no `toolCall` content blocks, same predicate as `isFinalAssistantMessage`, `index.ts:100-106`) through the branch tail. A branch with zero text-only assistants has the whole branch as its open segment (the incident case). All messages in the range count toward its chars, including user/steer messages - the range is measured as retained context, not filtered content.

**Open-cycle thinking tokens:** sum over assistant messages in the open segment of the chars of their content blocks with `type === "thinking"`, divided per the convention. Deliberately *not* windowed by the frontier: a skipped/oversized/trivial flush attempt advances the frontier but removes nothing from context, so a frontier window would reset to ~0 right after a skip while the stranded thinking is still fully retained - reproducing the incident's misleading-small-numbers symptom. This metric answers "how much thinking is retained in the chain Phase 3 cannot yet compress".

**Largest-chain share:** numerator = `max(largest closed chain, open segment)` - max, not sum. Closed chains come from `detectChains` over the branch; interrupted chains (`finalAssistantTimestamp: null`) count as closed for measurement purposes (they are retained context regardless of compressibility). A chain's chars = sum of per-message chars over the messages in its range. Denominator = sum of per-message chars over the entire branch projection (including custom summary messages present as branch messages). Share = `Math.round(100 * numerator / denominator)`; 0 when the denominator is 0. `src/chain-detector.ts` is not modified - the open-segment scan is a metrics-module concern (its closed-chain contract is load-bearing for Phase 3).

**Frontier boundary locator (used by frontier gap only):** replicate `captureUnindexedBatchesFromSession`'s turn-counter convention (`src/batch-capture.ts:81-86`): walk the branch incrementing a counter on *every* assistant message. The boundary turn is the assistant message whose counter equals `frontier.lastAttemptedTurnIndex` and which contains a `toolCall` block with id `frontier.lastAttemptedToolCallId`. Within the boundary turn, toolResults paired to calls up to and including that id are *at or before* the boundary (excluded); results paired to later calls in that turn and all messages after that turn are *after* the boundary. If `frontier` is null, or the turn is not found, or the id is not in that turn's calls (bare-id miss after tree navigation), the boundary is the branch start - whole-branch window. This mirrors `trimBatchToPendingRange`'s miss semantics (`index.ts:108-129`) without pretending to share its code, which operates on captured batches, not branches.

**Frontier gap:** sum of per-convention tokens over `ToolResultMessage`s after the boundary that are summarization-eligible: occurrence key not summarized (`isSummarized`) *and* not protected (`isProtected`, same predicate the `turn_end` capture filter uses, `index.ts:735-738`). Protected outputs are excluded because they are never capturable - counting them would keep the gap permanently non-zero with no pending work, contradicting the metric's meaning ("what could summarization reclaim").

### Component 2: reload rearm flag (`index.ts`)

New module-level `rearmedPending: boolean` (transient, never persisted):

- On `session_start` and `session_tree`, **after** reconstruction and the `pendingBatches` clear, run the existing capture rescan (`capturePendingBatches` - a pure branch scan + grouping, no LLM work). If it yields at least one non-empty batch after frontier trim, set `rearmedPending = true`. The rescan result is discarded - only the boolean survives (no queue reconstruction). In the same pass, compute the metrics snapshot for the new branch and refresh the footer widget (see Component 4) - this is the reload-with-no-further-turn visibility path.
- **`turn_end` restructure (the load-bearing part):** the budget/delta gate must be reachable without a freshly pushed batch. When `rearmedPending` is true, `turn_end` skips the `!hasToolResults` and `!batch` early returns for the purpose of gate evaluation: it still performs capture/spill/trim/push only when the turn has toolResults, but the budget/delta computation and the flush gate run regardless. The gate becomes `(pendingBatches.length > 0 || rearmedPending) && !isFlushing && (budgetHit || deltaHit)`. When `rearmedPending` is false, current behavior is unchanged (early returns intact; the pushed-batch guarantee makes the `pendingBatches.length > 0` operand redundant there, which is exactly why the flag alone - without this restructure - would be dead code).
- `message_end` (agent-message mode) already calls `flushPending` unconditionally, so "reload, then the chain closes" needs no change - the flush's own rescan recovers the work.
- `agent_end`: the guard becomes `pendingBatches.length === 0 && !rearmedPending`; widget text when the queue is empty but rearmed: `prune: recovered pending (reload)` (never the misleading `prune: 0 pending`); otherwise the existing `prune: N pending`.
- `rearmedPending` clears at the start of every `flushPending` invocation (any outcome - the flush's own capture rescan is then the source of truth) and is re-evaluated on the next reload.
- **Rescan failure:** if the reload rearm probe throws, `console.error` (the codebase's existing sink for non-prune-time failures, e.g. `src/spill.ts:71`) and leave `rearmedPending = false` - reload must never fail because of the probe. `DiagnosticSink` is not used: it is scoped to prune-time degradations.
- **`enabled: false`:** probe skipped entirely.

Rationale for flag-not-flush: the armed state changes nothing until an existing trigger (budget, delta, `message_end`, `/pruner now`) fires; immediate flush at boot was rejected (see out of scope). Honest residual gap: reload followed by *no further turns at all* gets visibility (footer, `agent_end`, `/pruner status`) but no automatic flush - by design.

### Component 3: per-attempt flush-metrics entry (`context-prune-flush-metrics`)

New custom session entry type, constant in `src/types.ts`. Written **once per non-concurrent `flushPending` invocation, regardless of outcome** - including empty-capture and error paths, because the incident's undiagnosable "`/pruner now` said nothing pending" is exactly an empty-capture attempt this log must record. Payload:

```ts
{
  ts: number;
  trigger: "budget" | "delta" | "message-end" | "manual" | "rearmed";
  capturedBatches: number;    // batches after rescan+trim, before processing
  processedBatches: number;
  outcome: "summarized" | "skipped-oversized" | "skipped-deduped" | "skipped-trivial" | "empty" | "error";
  metrics: ContextMetricsSnapshot;  // computed at flush ENTRY (pre-flush), so the pressure that triggered the flush is recorded
}
```

`outcome` reuses the `PruneFrontier.outcome` union verbatim for processed attempts and adds `empty` (nothing captured) and `error`. `trigger` is threaded from the call site.

- **Emission point:** the very end of `flushPending`, after the chain-compression block and outside its try/catch (compression failure is non-fatal and must not eat the entry). Routing mirrors frontier persistence (`index.ts:517-531`): `delivery === "runtime"` -> `pi.appendEntry`, else `sessionManager.appendCustomEntry`. Write failure is non-fatal (same posture as stats persistence).
- **Never in LLM context** (same hidden treatment as `context-prune-stats`).
- **Not reconstructed on `session_start`** - append-only observability log, not state; nothing reads it back at runtime.
- Deliberately **not** an extension of `context-prune-stats`: point-in-time metrics vs cumulative last-snapshot-wins counters would force reconstruction to distinguish field classes. `SummarizerStats`, `StatsAccumulator`, and the `cost:external` emission are untouched.
- AGENTS.md custom-entry table gains one row.

### Component 4: surfacing (`src/commands.ts` + cache in `index.ts`)

- **Snapshot cache:** owned by the `index.ts` closure. Recomputed at: reload rearm probe (Component 2), `turn_end` with toolResults, and `flushPending` entry. `commands.ts` call sites never compute - they read the cache via a getter callback wired at registration (`index.ts:891`, same pattern as `getStats`). Call sites that refresh the widget for unrelated reasons (`commands.ts:819/854/863/982/1079`) reuse the cached snapshot as-is.
- **`/pruner status`:** new `context` block - open-cycle thinking, largest-chain share, frontier gap (from an on-demand fresh computation via the callback, not the cache - status is rare and should be exact), plus a `rearmed: yes` line rendered only while the flag is set (omitted otherwise).
- **Footer widget:** `pruneStatusText` gains a compact suffix rendered **only when `frontierGapTokens > 0`**: `· think <N>k · gap <N>k · chain <P>%` (all three metrics per AC 2; `formatCompactCount` for the numbers). Idle footer (gap 0) is unchanged - no new noise. The suffix source is the cached snapshot, threaded as a new optional parameter alongside the existing `reclaim`/`diagnostics` parameters.

### Data flow

```
session_start/session_tree -> rebuild index/stats/frontier -> clear pendingBatches
  -> rearm probe: capture rescan -> rearmedPending = batches found
  -> compute metrics snapshot -> refresh footer (visibility without further turns)
turn_end -> [capture/spill/trim/push when toolResults] -> recompute snapshot
  -> gate (reachable even with no new batch when rearmed):
     (pending>0 || rearmed) && !isFlushing && (budgetHit || deltaHit) -> flushPending
flushPending -> clear rearmedPending -> pre-flush snapshot -> capture rescan (existing)
  -> summarize -> persist index/frontier/stats -> chain compression
  -> write context-prune-flush-metrics (always, outside compression try/catch)
/pruner status -> on-demand metrics computation -> context block
```

### Error handling / edge cases

- **Rearm probe throws:** `console.error`, `rearmedPending = false`, reload proceeds (Component 2).
- **Rearmed but flush-time rescan finds nothing** (another client summarized; trim excluded everything): flush takes its existing empty path; the flush-metrics entry records `outcome: "empty"`; flag already cleared.
- **Empty branch / no assistant messages:** all metrics 0; share 0 when the denominator is 0.
- **Frontier boundary unresolvable in branch** (tree navigation, legacy frontier): whole-branch window (Component 1 locator).
- **Flush-metrics entry write failure:** non-fatal; flush outcome unaffected.
- **`enabled: false`:** rearm probe skipped; no flush-metrics entries; `/pruner status` context block still renders (read-only scan, useful while deciding whether to enable).

### Testing

Bun test style:

- `src/context-metrics.test.ts` (new, pure): open-segment detection (incl. zero-text-only-assistant branch = whole branch); thinking sum over open segment only; share max-not-sum, interrupted chains as closed, denominator with custom summary messages, zero denominator; frontier-gap boundary location (intra-turn split, bare-id miss -> whole branch, null frontier), protected + summarized exclusion; measurement convention (JSON.stringify, Math.round).
- **AC 3 regression test** (`src/reload-rearm.integration.test.ts`, new): the repo has no existing harness that drives `index.ts` event handlers (all current suites test pure modules), so this test builds one: invoke the extension's default export with a mock `pi` whose `on` captures handlers into a map; fabricate a `ctx` with a fake `sessionManager` (`getBranch` returning a branch containing a captured-but-unflushed toolResult batch, `appendCustomEntry`, `getSessionDir`/`getSessionId`) and `getContextUsage` returning budget-crossing usage; stub the summarizer via the `mock.module("@earendil-works/pi-ai/compat")` pattern from `src/summarizer-wiring.test.ts`. Scenario: fire `session_start` (asserts rearm), then a `turn_end` with **no toolResults** and budget-crossing usage -> assert `flushPending` ran (summarizer stub invoked), the batch was summarized/indexed, and `pruneMessages` stubs its result. This scenario **fails on current `main`** (the `!hasToolResults` early return prevents the gate from ever being evaluated), which is what makes it a regression test.
- `src/commands.test.ts` additions: footer suffix present iff gap > 0 and contains all three metrics; status context block formatting; `rearmed:` line only when armed; `agent_end` string `prune: recovered pending (reload)` for the rearmed-empty case.
- Flush-metrics entry: exactly one entry per flush attempt, including empty-capture attempts and when chain compression runs or fails (guards the double-persist shape of stats at `index.ts:500-524` + `561-563` and the try/catch placement).

Verification: `bun test src/` plus the AGENTS.md typecheck command. Smoke test per AGENTS.md (`pi -e ./index.ts --no-extensions -p ...`, then jq over the session JSONL asserting a `context-prune-flush-metrics` entry appears).

## Documentation impact

- Feature / user-facing docs introduced: none (no new standalone doc; all changes amend existing docs)
- Materially amended existing docs: `doc/configuration.md` (footer metrics-suffix state, `/pruner status` context block, `prune: recovered pending (reload)` state - it is the repo's designated home for footer states and full command detail; ratified at the finish gate, G6), `PRUNING.md` (new "Single-chain sessions" subsection: Phase 3's closed-chain requirement as a known design property; guidance to lower `autoBudgetThreshold` / rely on `budgetTurnDelta` for long autonomous runs; the three metrics and their definitions; the rearm behavior), `README.md` (`/pruner status` context block, footer suffix)
- Derived / memory docs invalidated: `AGENTS.md` (custom-entry table: add `context-prune-flush-metrics` row; project-layout line for `src/context-metrics.ts`)

## Open questions

None blocking. Accepted unknown: the incident's "nothing pending" `/pruner now` output remains unexplained (JSONL gone); the per-attempt flush-metrics entries exist precisely so a recurrence is diagnosable.
