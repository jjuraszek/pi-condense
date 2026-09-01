# Custom-message chain anchors + opt-in frontier-gap flush trigger (gh-13)

Ticket: [jjuraszek/pi-condense#13](https://github.com/jjuraszek/pi-condense/issues/13)

## Problem

Two failures observed in long gauntlet-driven autonomous sessions, both rooted in
auto-continued tool-calling stretches that contain no real user message:

1. **Chain-detection gap (Group A).** `detectChains` (`src/chain-detector.ts:64-74`)
   opens a chain only on `role === "user"`. A `role: "custom"` steer (e.g.
   pi-gauntlet's `pi-gauntlet-transition-recovery`) auto-continues a tool-calling
   stretch with no intervening user message, so the stretch never becomes a closed
   chain: its toolCall arguments are never range-dropped and protected outputs are
   never relocated. Observed: 25 subagent-dispatch toolCall args (169KB, ~27% of
   post-prune context) permanently stuck; a 27KB protected read unable to relocate
   into a `<protected-output>` tag.
2. **No tail-size flush signal (Group B).** Existing opt-in triggers
   (`autoBudgetThreshold`, `budgetTurnDelta`) are window-*fraction* signals. On a 1M
   window the raw un-pruned tail reached 88,761 / 107,977 / 192,850 tokens without
   any flush - 192,850 tokens is only 19% of the window, below any sane fractional
   threshold. `frontierGapTokens` is already computed end-to-end
   (`src/context-metrics.ts:138-151`, flush-metrics, `/pruner status`) but drives no
   behavior.

## Design

Two independent, minimal changes. No new hooks, no new state, no new files.
Chain-compressor, backfill, indexer, and orphan-sweep consume detector/resolver
output through unchanged interfaces. Group A does touch three additional sites
beyond detector/resolver - the branch projection at both detection call sites,
the batch-capture rescan, and context-metrics anchor lookups - because all of
them hard-code user-only boundaries today (details below).

### Group A: custom messages as chain anchors

New exported predicate in `src/chain-detector.ts`:

```ts
export function isChainAnchorCustom(msg: any): boolean {
  return msg?.role === "custom" && !String(msg.customType ?? "").startsWith("context-prune-");
}
```

The predicate anchors chains in both the detector and the resolver, so they can
never disagree:

1. **`detectChains`**: an eligible custom message opens a chain **only while the
   detector is idle** (i.e. after a text-only assistant closed the previous chain,
   or at branch start). While a chain is open, an eligible custom message stays
   passthrough - it neither interrupts nor closes, exactly today's behavior. User
   messages keep their existing always-interrupt-and-open semantics. The existing
   synthetic-body exclusion (`isSyntheticChainMessage`, user-role
   `<compressed-chain` prefix, `src/chain-detector.ts:4-13`) is unchanged.
   Rationale for idle-only: a custom that *interrupted* an open chain would emit
   the prefix with `finalAssistantTimestamp: null`, which `selectEligible`
   permanently rejects (`src/chain-compressor.ts:50-54`) - the prefix would become
   forever incompressible, a reclaim regression versus today where the whole
   stretch compresses once a text-only assistant eventually closes it. Idle-only
   is strictly no-worse-than-today: mid-chain customs behave identically to the
   current code, and the motivating case (a gauntlet recovery steer arriving
   after the agent stopped with a text-only assistant, i.e. while idle) is fully
   covered. A custom steer delivered mid-tool-loop is the accepted, documented
   limitation: that stretch stays un-chained exactly as it is today.
2. **`resolveRange`** (`src/chain-range-prune.ts:68-99`): the start-anchor match
   widens to `msg.role === "user" || isChainAnchorCustom(msg)`. Everything else is
   untouched: exactly-one-start, exactly-one-end (assistant-only end anchor),
   `startIndex < endIndex`, no id-set or timestamp-window fallback (the fallback
   class that deleted live turns - see
   `doc/specs/2026-08-12-toolcall-id-collisions.md`).

**Branch projection (load-bearing third change).** Pi persists extension steers as
`type: "custom_message"` session entries, not `type: "message"`. Both production
`detectChains` feed sites filter to `e.type === "message" && e.message`
(`index.ts:605` in `flushPending`, `index.ts:1028` in `compactChains`), so without
a projection the widened predicate would never see a `role: "custom"` message in a
real session - a unit-test-only fix. The projection already exists in
`computeMetricsSnapshot` (`index.ts:107-113`): include `custom_message` entries as
`{ role: "custom", customType, content, display, details, timestamp: new
Date(e.timestamp).getTime() }`. Extract it into one shared helper and use it at
all three sites (`computeMetricsSnapshot`, `flushPending` detection,
`compactChains` detection) so anchor timestamps are identical everywhere.

**Batch-capture rescan boundary.** `captureUnindexedBatchesFromSession`
(`src/batch-capture.ts:74-100`) also filters to `type === "message"` and
increments `userTurnGroup` only on `role === "user"`. In
`batchingMode: "agent-message"` a summary group could then span an eligible
custom anchor, producing one per-batch summary covering tool calls from two
different chains - compressing one chain could relocate or duplicate the shared
summary. Fix: the rescan walks `custom_message` entries too (projected the same
way) and increments `userTurnGroup` on every eligible custom (`isChainAnchorCustom`),
while `context-prune-*` entries stay passthrough. Splitting a summary group is
always safe - it only makes summaries finer-grained, never coarser.

**Context-metrics anchor lookups.** `computeContextMetrics` consumes `detectChains`
output but resolves chain starts with a user-only `findIndex`
(`src/context-metrics.ts:78`). Custom-anchored ranges would get `startIdx === -1`
and be silently skipped, undercounting `largestChainSharePct` in exactly the
sessions this feature targets. Fix: the start-anchor lookup uses the shared
`isChainAnchorCustom` disjunction. The interrupted-chain next-anchor walk
(`src/context-metrics.ts:89`) stays user-only - under idle-only semantics, only a
user message can interrupt an open chain. The existing metrics test pinning
`role: "custom"` as denominator-only is updated: `context-prune-*` customs stay
denominator-only; a third-party custom may now anchor a chain.

**Exclusion policy (load-bearing):** the `context-prune-` namespace prefix excludes
every pruner-emitted custom message - today that is `context-prune-summary` (the
per-batch summary steer), and by construction any future pruner customType. Without
this exclusion the pruner's own summaries would fragment every chain they land in.
Synthetic chain bodies need no new code (user-role, already excluded). Third-party
custom messages becoming anchors is intended and acknowledged in the ticket.

**Naming:** `ChainRange.startUserTimestamp` and the persisted
`ChainCompressionEntry.startUserTimestamp` keep their names. A rename would churn
persisted-entry compatibility for zero behavior; the field now means "start anchor
timestamp (user or eligible custom)". A doc comment records this.

### Group B: opt-in frontier-gap flush trigger

**Config.** `frontierGapThresholdTokens: number | null` on `ContextPruneConfig`
(required-with-null, matching the sibling `autoBudgetThreshold` style at
`src/types.ts:403`, not optional-with-`?`),
default `null` in `DEFAULT_CONFIG` (`src/types.ts`). `normalize()` in
`src/config.ts`: non-null values must be finite and `> 0`, floored to integer;
invalid values reset to `null` (same forgiving style as the existing nullable
validators at `src/config.ts:82-108`). Config-file-only - no `/pruner settings`
overlay row, no presets: the `budgetTurnDelta` treatment.

**Gate wiring.** At the existing `turn_end` gate (`index.ts:934-961`) - the sole
trigger site, after the existing `if (!pushedBatch && !rearmedPending) return;`
guard:

```ts
let gapHit = false;
if (cfg.frontierGapThresholdTokens != null) {
  const snap = computeMetricsSnapshot(ctx);          // existing helper, index.ts:96-123
  // snap is ContextMetricsSnapshot | undefined (the helper catches internal
  // errors); a failed snapshot fails closed - no gap flush.
  gapHit = snap != null && snap.frontierGapTokens >= cfg.frontierGapThresholdTokens;
}
// existing flush condition gains one OR:
(n > 0 || rearmedPending) && !isFlushing && (budgetHit || deltaHit || gapHit)
```

The trigger ternary and the user notification both gain an explicit gap branch
(without this, a gap-only flush would be recorded as `"delta"` and announce
"context jumped this turn"):

```ts
trigger: n === 0 ? "rearmed" : budgetHit ? "budget" : deltaHit ? "delta" : "frontier-gap"
// safeNotify: budgetHit ? "context budget reached" : deltaHit ? "context jumped this turn"
//           : "un-pruned tail exceeded frontier gap threshold"
```

**Trigger value.** `"frontier-gap"` joins the `FlushTrigger` union
(`src/types.ts:711`). Precedence: existing `rearmed` handling unchanged, then
`budget` > `delta` > `frontier-gap` - persisted trigger values are byte-identical
to today whenever the old signals fire; `frontier-gap` appears only when it is the
sole cause. The persisted `context-prune-flush-metrics` entry needs no shape change
(`trigger` and the pre-flush snapshot fields already exist).

**Cost.** When `null` (default): the snapshot is not computed - zero extra work,
byte-identical behavior. When opted in: the same order of work as the per-flush
metrics snapshot (`computeContextMetrics` rescans the branch per unsummarized
toolResult via `findArgsForToolCallId`, so it is O(branch x unsummarized-tail),
not strictly linear), paid once per gated turn_end. A turn that fires also pays
it a second time inside `flushPending`, as budget/delta flushes already do.

**Self-throttling.** The frontier advances on every *processed* flush outcome -
summarized and `skipped-oversized` / `skipped-trivial` / `skipped-deduped` alike -
resetting `frontierGapTokens` to near-zero, so the trigger re-arms only after
another T tokens of tail accumulate. Two qualifications: (a) a flush that finds
zero capturable batches exits before the frontier snapshot and does not advance
it - rare behind the `n > 0 || rearmedPending` gate guard, and it also produces
no context rewrite, so it cannot churn the cache; (b) on a mid-flush summarizer
failure, `flushPending` persists the successful prefix and advances the frontier
only to that prefix - the next gated turn may fire again on the remaining
backlog. That re-fire consumes backlog (monotonic frontier progress, bounded by
the pending batch count) rather than reacting to new content, so the cadence
converges instead of oscillating; the bound is amortized "one extra prefix
rewrite per T tokens of *new* tail growth", not per-turn-exact under failures.
No cooldown timer, nothing persisted, nothing to rebuild on `session_start`.

## Regression risk assessment

The operator's hard constraint: do not reintroduce constant prompt-cache-prefix
rewrites. Authoritative cache rationale: PRUNING.md ("Why Frequent Pruning Busts
Cache" / "The Sweet Spot: Batch and Prune") and the README trigger table - not
issue #7's thread, despite #13's attribution.

- **Group B is inert by default.** `null` means the gap code path is never entered.
  No existing user sees any change.
- **Opted-in worst case is structurally bounded.** The gap trigger (a) evaluates
  only at `turn_end`, never on `context` renders, timers, or tool-loop events -
  the per-render recomputation that caused the historical thinking-strip cache
  churn (`doc/specs/2026-08-04-thinking-strip-flush-gated.md`, feature since
  removed) is a different site this change does not touch; (b) runs only when a
  batch was pushed or rearmed this turn, so a large gap with no capturable work
  cannot cause repeated empty flush attempts; (c) fires at most one flush per turn
  (existing `isFlushing` + once-per-gate structure); (d) resets via frontier
  advance on *every* attempt, including skips. Net bound: **at most one extra
  prefix rewrite per T tokens of tail growth**, by construction. This is the
  batch-then-prune cadence PRUNING.md endorses, applied to a signal that only
  exceeds T in pathological auto-continued stretches.
- **Unsummarizable tails cannot loop.** `frontierGapTokens` excludes summarized and
  protected results by construction (`src/context-metrics.ts:138-149`), so a tail
  of purely protected outputs never counts toward the gap and cannot cause a
  fire-flush-fire loop.
- **Group A is not opt-in but strictly no-worse-than-today.** The idle-only opener
  means the only behavioral delta is *additive*: stretches that previously never
  became chains (custom steer while idle) now do. Mid-chain customs behave
  byte-identically to today (passthrough; the enclosing chain still compresses as
  one range once closed). The interrupt path was deliberately **not** widened:
  interrupting would emit the prefix with `finalAssistantTimestamp: null`, which
  `selectEligible` permanently rejects (`src/chain-compressor.ts:50-54`) -
  a reclaim regression this design avoids by construction. Residual risks:
  (1) a newly-anchored chain can land in the #10 zero-coverage
  deterministic-backfill path - already shipped, fail-closed, covered by a
  targeted test below; (2) `agent-message` summary groups now split at eligible
  custom anchors - strictly finer summaries, never coarser. Wrong-range drops
  cannot happen: `resolveRange` stays unique-match-or-null, and a user/custom
  timestamp collision yields `startMatches === 2` -> `null` -> chain skipped
  with an `unresolved-range` diagnostic.
- **Persisted-entry compatibility.** Old user-anchored `ChainCompressionEntry`
  records resolve identically under the widened predicate (superset + unchanged
  uniqueness gate). A custom-anchored entry replayed under a *downgraded* extension
  fails to resolve -> fail-closed skip, not corruption.
- **Recoverability guarantee preserved.** Custom-anchored chains flow through the
  same per-batch summary / deterministic-backfill machinery, so every dropped
  toolCall remains recoverable via `context_tree_query` (the #10 invariant).

## Edge cases

- Custom message mid-chain: passthrough, chain stays open (unchanged from today;
  the idle-only rule). Documented limitation: a steer delivered mid-tool-loop
  does not anchor that stretch.
- Custom message while idle: opens a chain (the fix).
- `context-prune-summary` steer anywhere: passthrough, never an anchor (the
  regression guard).
- Timestamp collision across the widened anchor set (user+custom, custom+custom):
  `resolveRange` returns `null`; chain skipped, diagnostic emitted.
- `frontierGapThresholdTokens: 0` or negative or non-finite: normalized to `null`
  (disabled). `0` is not a valid always-on threshold.
- Gap hit with concurrent flush in flight: existing `isFlushing` guard defers, as
  for budget/delta.
- Orphan-sweep already treats custom as a barrier role; no interaction change.

## Out of scope

- Non-null default for `frontierGapThresholdTokens`. Promotion to a default is an
  explicit non-goal, deferred to a follow-up with `context-prune-flush-metrics`
  field evidence (the entries already persist `frontierGapTokens` per flush).
  Flipping it later is a one-line change plus CHANGELOG.
- Args-purge for toolCall arguments stuck in open chains.
- Changing what counts as a chain *end* (assistant text-only, unchanged).
- Changing existing budget/delta trigger defaults or semantics.
- `/pruner settings` overlay row or presets for the new setting.
- The general fully-open single-chain problem (PRUNING.md "Single-chain sessions").

## Testing

All `bun:test`, following existing fixture conventions.

- `src/chain-detector.test.ts`: custom message while idle opens a chain; custom
  mid-chain is passthrough and the enclosing chain still closes as one range
  (pins the idle-only rule); `context-prune-summary` custom is passthrough in
  both states; a hypothetical future `context-prune-*` type is excluded;
  synthetic user body still excluded.
- `src/chain-range-prune.test.ts`: `resolveRange` matches a custom start anchor;
  user+custom same-timestamp collision -> `null`; duplicate custom timestamps ->
  `null`; user-anchored resolution unchanged (regression pin); end-to-end
  `applyChainCompressions` over a custom-anchored range preserves drops +
  protected-output relocation.
- Backfill interaction: custom-anchored chain with zero per-batch summary coverage
  flows through deterministic backfill (`bodySource: "deterministic"`) - the
  #10 x #13 case.
- Projection integration test: a session branch containing a real
  `type: "custom_message"` entry (e.g. `customType:
  "pi-gauntlet-transition-recovery"`) produces a persisted `context-prune-chain`
  entry whose `startUserTimestamp` matches that entry, while a
  `context-prune-summary` custom_message in the same branch anchors nothing.
  This is the test that would have caught the unit-test-only failure mode.
- Cross-anchor batching: in `agent-message` mode, batches on either side of an
  eligible custom anchor land in different summary groups (`userTurnGroup`
  boundary pin).
- Pure config/trigger tests (`src/budget.test.ts` style): threshold comparison
  including the `snap === undefined` fail-closed branch; `normalize()` flooring
  and invalid -> `null`.
- Integration (`src/reload-rearm.integration.test.ts` style): opted-in session
  where budget/delta never trip but the gap does -> exactly one flush with
  `trigger: "frontier-gap"` in the persisted flush-metrics entry and the
  gap-specific notify string; budget+gap co-fire persists `"budget"` (precedence
  pin); default-`null` session -> no gap flush (no snapshot-count assertion -
  `computeMetricsSnapshot` is a factory closure and not observable without
  indirection; the behavioral pin suffices).
- Partial-failure cadence: multi-turn test where a mid-flush summarizer failure
  persists a prefix and the next gated turn re-fires on the remaining backlog -
  asserts the frontier advances monotonically across the two flushes (the
  converging-cadence pin for the cache constraint).

Verification: `bun test src/` plus the AGENTS.md typecheck command. Smoke test per
AGENTS.md: `pi -e ./index.ts --no-extensions -p "..."` against an isolated
`$PI_CODING_AGENT_DIR`, inspecting `context-prune-flush-metrics` entries for the
`frontier-gap` trigger.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (trigger table gains
  `frontierGapThresholdTokens`, recommended starting value `80000`),
  `doc/configuration.md` (setting, validation, default-`null` rationale, guidance:
  set well above normal per-flush accumulation so it fires only in pathological
  auto-continued stretches), `PRUNING.md` (chain-anchor definition now includes
  non-pruner custom messages; frontier-gap trigger in the trigger/cache section),
  `CHANGELOG.md`
- Derived / memory docs invalidated: none (AGENTS.md routing and customType tables
  unaffected - no new customType, no new file)

The recommended value `80000` sits above ordinary batch accumulation (~5-15k
tokens) and below the observed 88k+ pathological tails.

## Open questions

None. All decisions above are pinned: namespace-prefix exclusion, config-file-only
setting, `budget` > `delta` > `frontier-gap` precedence, default `null` with
documented `80000` recommendation, no predecessor spec superseded.
