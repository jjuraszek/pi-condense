# Spec: unified cost event + live-reclaim status line

Date: 2026-06-21
Branch: `cost-event-reclaim-status`

## Problem

Two defects in how the pruner surfaces itself:

1. **Pruner spend is invisible to the unified total.** The summarizer makes its own
   `stream()` calls (`src/summarizer.ts` `runSummarization`) that bypass the agent loop, so
   they never reach `message_end` and never enter pi-subagents' grand total (`Σ$...`). The
   pruner instead shows its own isolated cost (`↑3.0k ↓1.3k $0.021`).
2. **The status line shows price, not value.** `prune: ON (On agent message) │ ↑3.0k ↓1.3k
   $0.021` reports what pruning *costs*, never what it *reclaims*. A user cannot tell whether
   pruning is doing a good job.

## Goals

- Pruner publishes its cumulative LLM spend on a shared `pi.events` channel so pi-subagents
  (or any aggregator) can fold it into one `Σ$` as a third cost signal. Fire-and-forget; no
  hard dependency on pi-subagents.
- Status line headline becomes a compact reclaim ratio: `prune: ON │ 92k->14k (-85%)`.

## Non-goals

- pi-subagents-side aggregation (separate spec in that repo, against the same contract).
- Durability of the external-cost slice across session reload. Decided **live-only**: the
  external cost is ephemeral; no session reseed. Rationale: it is a minor fraction of the
  total and durability is not worth coupling an aggregator to the pruner's entry schema.
- Exact token accounting for reclaim. The headline uses an estimate (chars / 4).

## Change 1 - emit cost on the shared bus

### Contract (fixed interface, shared with the pi-subagents spec)

- **Channel:** `pi.events` string channel `"cost:external"`.
  `EventBus.emit(channel: string, data: unknown)` per
  `node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.d.ts`. `ExtensionAPI`
  exposes this bus as `events: EventBus` (types.d.ts ~line 962), so any site that already
  holds `pi: ExtensionAPI` can emit with no signature change.
- **Payload** (cumulative-per-source, NOT deltas):

  ```ts
  interface ExternalCostUpdate {
    source: string;        // stable producer id: "pi-context-prune"
    totalCost: number;     // cumulative USD this source spent THIS SESSION
    inputTokens?: number;  // cumulative this session, optional (for breakdown display)
    outputTokens?: number; // cumulative this session, optional
  }
  ```

  `ExternalCostUpdate`, plus the constants `EXTERNAL_COST_CHANNEL = "cost:external"` and
  `EXTERNAL_COST_SOURCE = "pi-context-prune"`, are declared and **exported** from
  `src/types.ts` (not spec-prose only) so the contract is importable in one place.
- **Semantics:** "cumulative" means cumulative **for the current session**, not all-time. The
  producer emits its running session total on every update. Cumulative-per-source is
  idempotent and replay-safe within an aggregator run: a re-emit overwrites the same key,
  never double-counts. The aggregator keeps `Map<source, payload>` and sums `totalCost`.

### Producer wiring (this repo)

**Session-scoped delta, not raw cumulative.** `StatsAccumulator.reconstructFromSession`
(`src/stats.ts:96`) reloads prior-session `context-prune-stats` totals on `session_start`.
Emitting `getStats()` directly would republish historical spend to a freshly started
aggregator, breaking the live-only contract. Fix:

- `StatsAccumulator` captures a **session baseline** - a snapshot of `{ totalCost,
  totalInputTokens, totalOutputTokens }` taken at construction (zero) and re-captured at the
  end of `reconstructFromSession` (equal to the carried-over totals).
- New method `getSessionDelta()` returns `{ totalCost, inputTokens, outputTokens }` = current
  totals minus the baseline - i.e. only this session's spend.
- The `cost:external` payload maps from `getSessionDelta()`, with the constant `source`.

**Emit at every stats-write site, not only `persist`.** `persist(pi)` is NOT the sole
stats-write path: the default `message_end` -> `delivery: "session"` branch writes via
`appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats())` (`index.ts:498`), bypassing
`persist`. Emitting only inside `persist` would miss the main agent-message summarization
path. Fix:

- Add a free helper `emitExternalCost(pi, accumulator)` (in `src/stats.ts` or a small util)
  that emits `{ source: EXTERNAL_COST_SOURCE, ...accumulator.getSessionDelta() }` on
  `EXTERNAL_COST_CHANNEL`.
- Call it immediately after **every** site that writes stats: both branches of the
  stats-write in `flushPending` (`index.ts` runtime `statsAccum.persist(pi)` ~493 and session
  `appendEntry` ~498) and the chain-compression stats writes (~534, ~839). Simplest form:
  fold the emit just after the runtime/session if-else so it runs unconditionally on each
  flush.
- Idempotency makes the multi-site emit safe: re-emitting the same session delta is a no-op
  at the aggregator.

## Change 2 - live reclaim headline

### Measurement (single point, all mechanisms)

`pruneMessages` (`src/pruner.ts`) is the one place where every reclaim mechanism
(stub-replace, error-purge, chain-range-prune, thinking-strip) runs against the full message
array. Measure once there, only when a prune actually occurs (the function already
short-circuits and returns the original array reference when nothing changes):

- `beforeChars` = `sizeMessages(messages)` (the input array, raw outputs still present).
- `afterChars` = `sizeMessages(pruned)` (the returned pruned array).

`sizeMessages(messages: AgentMessage[]): number` is a pure helper defined as
`JSON.stringify(messages).length`. Serializing the whole array (not just visible `.text`)
is deliberate: it counts tool-call argument bodies (error-purge reclaim), thinking blocks
(thinking-strip reclaim), and tool-result arrays (stub-replace / chain-range reclaim) -
so all four mechanisms register. It is an estimate of context weight, not an exact token
count.

This captures all four mechanisms with zero per-path plumbing. It is a **live** measurement
(current pruned context vs the same context unpruned), self-correcting each turn, with no
cumulative drift.

### Carrying the measurement to the status line

- `StatsAccumulator` (`src/stats.ts`) gains a **transient** live-reclaim field
  (`liveBeforeChars`, `liveAfterChars`), set via a new method (e.g. `setLiveReclaim(before,
  after)`).
- These transient fields are **separate from `SummarizerStats`** (which stays the persisted
  schema). `getStats()` returns the persisted `SummarizerStats` for the
  `context-prune-stats` entry unchanged; the status widget reads the live reclaim via a
  distinct accessor (e.g. `getLiveReclaim()`) or an extended widget-only view object. The
  persisted entry schema is untouched; the live value resets to unset on `session_start` and
  stays so until the next prune.
- The `context` event handler in `index.ts:787` currently destructures the context as `_ctx`
  (unused). Rename it to `ctx` and use it: stash the `pruneMessages` before/after into the
  accumulator and refresh the status widget via `setPruneStatusWidget(ctx, config,
  statsAccum.getStats())`. `ExtensionContext.ui.setStatus` is already available - no
  signature change beyond using the parameter.

### Status line format

`pruneStatusText(config, stats)` (`src/commands.ts`) renders:

| State | Line |
|---|---|
| Enabled, reclaim measured this session | `prune: ON \| 92k->14k (-85%)` |
| Enabled, nothing pruned yet | `prune: ON` |
| Disabled | `prune: OFF` |

- Tokens estimated as `Math.round(chars / 4)`, formatted with the existing
  `formatCompactCount` (`k`/`M`) helper used elsewhere in `commands.ts`.
- Reduction `= round((1 - afterTokens / beforeTokens) * 100)`, clamped to `>= 0`. A full
  strip (`afterTokens == 0`, `beforeTokens > 0`) correctly renders `-100%`.
- Drops the `(On agent message)` mode label and the `↑↓$` figures from the line.
- **Cost leaves the status line entirely.** It now flows into pi-subagents' `Σ$`. Full
  token/cost/call detail remains available in `/pruner stats` (unchanged).

## Edge cases

- **No prune this turn:** `pruneMessages` returns early; no measurement, status line keeps
  the last value (or `prune: ON` if never pruned).
- **`beforeChars == 0`:** show `prune: ON` (no ratio); never divide by zero.
- **Negative/zero reclaim** (summary larger than raw, rare): clamp reduction to `0%`.
- **Oversized/spilled outputs not in context:** measured as-is; the headline is an estimate,
  not an exact byte count.
- **No aggregator listening:** `pi.events.emit` is a no-op with no subscribers; pruner
  behavior is unchanged.

## Testing

- **Reclaim calc (pure):** unit test in the `pruner` test that before/after char totals and
  the formatted ratio string are correct, including the clamp and zero-before cases.
- **Emit (unit):** assert `persist` emits one `"cost:external"` event whose payload carries
  the cumulative `{ source, totalCost, inputTokens, outputTokens }` from current stats.
- **Status text (unit):** `pruneStatusText` renders each of the three states correctly.
- **Smoke:** `pi -e ./index.ts -p "..."` against an isolated `$PI_CODING_AGENT_DIR`.
  `--no-extensions` is dropped: it would suppress the very extension under test. Verify the
  ratio renders (inspect the status widget / session output) and that `context-prune-stats`
  JSONL entries still validate against the unchanged `SummarizerStats` schema (`jq` the
  `customType` counts per AGENTS.md).

## Documentation impact

- **README.md:** update the status-line description; document the `cost:external` emit and the
  `ExternalCostUpdate` contract.
- **PRUNING.md:** note the live-reclaim metric (single-point measurement in `pruneMessages`,
  estimated tokens).
- **AGENTS.md:** add `cost:external` to the event/contract surface (it is an outbound
  `pi.events` emit, not a session custom entry, so note it as such).

## Open questions

None.
