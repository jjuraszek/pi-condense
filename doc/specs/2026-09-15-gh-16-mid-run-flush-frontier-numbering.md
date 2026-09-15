# Mid-run auto-flush: derive live turn index from the session branch

**Ticket:** jjuraszek/pi-condense#16
**Date:** 2026-09-15
**Predecessor:** none

## Problem

pi-condense compares two different turn-numbering domains when deciding whether a live `turn_end` batch is new enough to reach the mid-run trigger gate:

- **Persisted frontier** (`context-prune-frontier` entries, `src/frontier.ts`) is session-wide: it is written by `flushPending` from the last processed batch's `turnIndex` (`index.ts:612-631`), and mid-run recovery batches get their index from `captureUnindexedBatchesFromSession`, which counts every assistant message in the branch from session start (`src/batch-capture.ts:108-136`).
- **Live `turn_end` batches** carry `event.turnIndex` (`index.ts:892-897`), which Pi resets to 0 on every `agent_start` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:428-451`).

`trimBatchToPendingRange` (`index.ts:150-171`) drops any batch with `batch.turnIndex < frontier.lastAttemptedTurnIndex`. After a human reply starts a new agent run, the run-local counter restarts below the persisted session-wide frontier, so every live batch is dropped until the run's index catches up. The budget, delta, and frontier-gap triggers (`index.ts:956-990`) never evaluate during that window. Work is not lost - the flush-time rescan recovers skipped batches later - but the frontier-gap trigger shipped in #13 is exactly the signal meant to bound long tails, and it is inert after every human reply.

Observed in the wild (#16): frontier 83 persisted at message-end; after a human "go", the next run made per-run indices 0-83 with zero attempts, crossed an 80k gap threshold, and only budget-flushed at per-run index 83 with ~193k eligible tail tokens. Corpus: 229/234 idle-started flushes at or after the frontier; 0 frontier decreases across 19,726 entries. Steers into an already-running agent do not reset the counter and are unaffected.

Root cause is not a recent regression: `eea6e4a` introduced the frontier comparison and `850f1d7` made the rescan counter session-wide and monotonic; both sides of the mismatch date from May. The `src/batch-capture.ts:109-113` comment claiming parity with Pi's `event.turnIndex` numbering is false beyond the first run of a session.

## Goal

A live `turn_end` batch's `turnIndex` is expressed in the same session-wide domain as the persisted frontier, so a new run's early batches reach the existing trigger gate. Persisted frontier values stay valid and monotonic; nothing about trigger semantics, cadence, thresholds, or the render path changes.

## Design

### Derive the session-wide index at live capture

Add a helper in `src/batch-capture.ts`, next to the rescan it must agree with:

```ts
export function deriveLiveTurnIndex(branch: SessionEntry[]): number
```

It reuses `projectBranchMessages(branch)` and counts every projected assistant message - the identical rule `captureUnindexedBatchesFromSession` uses (assistant messages only, text-only/pruned ones included, user/tool/custom excluded) - and returns `count - 1`, the index the rescan assigns to the branch's last assistant message. A branch with zero projected assistant messages returns `-1`: unreachable in the runtime (every `turn_end` follows a persisted assistant message), reachable only in harness tests that boot with an empty branch, and the only fallback is the `getBranch()`-throw path below.

`FlushMetricsEntry` (`src/types.ts`) gains a `stubCount: number` field - the count of tool calls the flush newly made stub-eligible: dedup aliases on processed batches plus calls of actually-indexed batches; 0 when nothing was indexed or aliased (all-trivial/oversized without aliases, or failure before any batch was processed). The emitter populates it (`index.ts:249-263`). AC8 asserts on this field, so it ships in this change.

The `turn_end` handler in `index.ts` (currently `index.ts:892-897`) calls `ctx.sessionManager.getBranch()`, derives the index, and passes it to `captureBatch` in place of `event.turnIndex`.

### Why the timing is safe

Pi persists the assistant message and its tool results at their `message_end` events, and extension emit happens before persistence within each event (`agent-session.js:352-366`). All `message_end` events of a turn precede its `turn_end`, so at `turn_end` the branch already contains the just-ended assistant message. The live batch's message **is** the branch's last assistant message, hence `count - 1` is its rescan index. Parity is by construction: one counting rule, one projection function, shared by both call sites.

### What does not change

- `trimBatchToPendingRange`, `src/frontier.ts`, persisted frontier fields, indexer occurrence identity, chain code, `pruneMessages` - untouched.
- Trigger semantics: budget > delta > frontier-gap, `turn_end`-only, at most once per turn, evaluated when a non-empty batch was pushed **or** when `rearmedPending` is set (the existing reload-recovery exception at `index.ts:950-960`); both conditions preserved as-is.
- Message-end behavior, manual `/pruner` commands, `context_prune` tool.
- The rejected alternative - capturing live turns by running the full rescan at every `turn_end` and taking the last batch - restructures the eager-spill path for parity the helper already provides by construction.

### What changes as a side effect

Live-captured `turnIndex` values persisted through the eager-spill path (`index.ts:920-935` -> `src/spill.ts` -> `src/indexer.ts`) and through summary details (`src/summary-refs.ts:69`) move into the session-wide domain - consistent with rescan-produced records. This is visible in `context_tree_query` output (`Turn: N`, `src/query-tool.ts:59`) and `/pruner` tree headers. No consumer compares these values across domains, so the only observable difference is consistency.

## Error handling and edge cases

- **`getBranch()` throws at `turn_end`:** fall back to `event.turnIndex` (today's behavior). Matches the existing swallow-and-fall-back convention in `capturePendingBatches` (`index.ts:194-197`); a transient branch failure must never block the turn.
- **Assistant message absent from the branch at `turn_end`:** unreachable in the current agent loop - aborted/error turns still emit and persist `message_end` before `turn_end`, and that `turn_end` carries `toolResults: []`, so the handler returns before capture. If a future runtime change made it reachable, the derived index would alias the previous assistant message; at equal-index the suffix logic could then keep the live calls rather than drop them. Accepted without machinery either way; not documented in PRUNING.md as a live failure mode.
- **Compaction and session reload:** compaction appends an entry without removing messages, so the branch still contains all messages root-to-leaf and the count is stable across compaction and reconstructable after reload. This preserves the observed "frontier never decreases" invariant.
- **Steer into a running agent:** no `agent_start`, no reset; unaffected.
- **Equal-index partial turn:** unchanged; `trimBatchToPendingRange`'s existing same-turn suffix logic (third call survives when the frontier recorded the second) operates on the now-correct index.
- **Cache-prefix stability:** the change alters which batches reach the trigger gate, never rendered content; two renders of unchanged history stay byte-identical.

## Testing

`bun test src/` (the CI/release gate). Unit tests follow `src/batch-capture.test.ts` conventions; integration tests use the existing `turn_end` harness in `src/reload-rearm.integration.test.ts` (real indexer/pruner flow). Every regression test below must fail on the pre-fix tree.

Harness recipe for the frontier-seeded tests (items 2-6): seed the branch with text-only assistant messages up to the frontier index (the rescan counts them but finds no recoverable work, so `rearmedPending` stays false at `session_start`), plus one `context-prune-frontier` entry carrying `lastAttemptedTurnIndex`. Append each live turn's assistant message and tool results to the branch **before** firing `turn_end`, matching pi's persist-before-`turn_end` ordering (`agent-session.js:352-366`). Observable for "survived trim": the `pruner: N turn(s) queued` notification or an index entry containing exactly the surviving call ids. Observable for "reached the gate": a `context-prune-flush-metrics` entry whose trigger is the expected one, never `rearmed`.

1. **Parity (AC5):** the branch's last assistant message carries a ready, unsummarized tool call, and the fixture interleaves text-only assistant messages, `custom_message` steers, pruner `custom` entries, and a `compaction` entry. Assert `deriveLiveTurnIndex(branch) === <projected assistant count> - 1` and that it equals the `turnIndex` of the batch `captureUnindexedBatchesFromSession` emits for that same last turn.
2. **Dead-zone fix (AC1):** persisted frontier 83 (branch seeded with 84 text-only assistants); a new run's live batch at per-run position 0..5 with unindexed calls survives `trimBatchToPendingRange` (queued notification / index entry) and reaches the gate (non-`rearmed` metrics entry).
3. **No re-summarization (AC2):** the equivalent already-summarized batch is still dropped.
4. **Ordinary path preserved (AC3):** live index above the frontier with unindexed calls reaches the evaluator; summarized calls still drop.
5. **Equal-index partial turn (AC4):** three-call batch whose derived index equals the frontier and whose recorded call is the second - only the third call's id lands in the index / summarizer input.
6. **Integration (AC7):** `autoBudgetThreshold` and `budgetTurnDelta` null, all output eligible, `frontierGapThresholdTokens: 1000`, frontier 50 (51 seeded text-only assistants). Gap is measured as `Math.round(JSON.stringify(toolResult).length / 4)`, so size the new turns' serialized results to measure below 1000 after turn 1 and at least 1000 after turn 2. Turn 2 produces exactly one `context-prune-flush-metrics` entry with `trigger: "frontier-gap"`; no earlier turn produces one.
7. **Fixture compatibility (AC8):** check in `src/fixtures/gh16-frontier-83.jsonl` - a pre-fix session JSONL containing >= 84 assistant messages (with all pre-frontier tool results indexed, so boot finds nothing recoverable) and a `context-prune-frontier` entry with `lastAttemptedTurnIndex: 83`. Loader: `readFileSync` + line-split `JSON.parse` into `SessionEntry[]`. With budget/delta off and `frontierGapThresholdTokens` set so only the gap trigger can cross, one eligible live `turn_end` produces a metrics entry with `stubCount > 0`, `outcome: "summarized"`, and persists a next frontier `>= 83`.
8. **Cache-prefix guard (AC6):** two `pruneMessages` renders of unchanged history are byte-identical; asserted pre-fix as a guard.
9. **Smoke test (AC10):** post-implementation, an isolated `$PI_CODING_AGENT_DIR` session loading pi-condense (`-e ./index.ts`): with pre-run frontier >20, a human reply (a continued-session prompt, which triggers the same `agent_start` reset a gauntlet gate reply does; gauntlet's gates are TUI-only and not scriptable in this environment) followed by a run crossing the gap threshold within its first 20 tool turns flushes on the crossing turn. Evidence: the session JSONL shows the pre-run frontier >20, the reply, and a `context-prune-flush-metrics` entry with `trigger: "frontier-gap"` or `"budget"` on the crossing turn (before the per-run index reaches the old frontier).

The false parity comment at `src/batch-capture.ts:109-113` is corrected in the same change (AC9).

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: PRUNING.md (flush frontier section - the turn-index numbering domain and the session-branch derivation); CHANGELOG.md `## [Unreleased]` gains a `### Fixed` entry
- Derived / memory docs invalidated: none

## Out of scope

- Replacing the persisted turn-index frontier with timestamp/id semantics (explicitly rejected by #16).
- Changing trigger thresholds, precedence, cadence, or making frontier-gap non-opt-in (settled in #13).
- Render-path changes or rewriting already-rendered prompt content.
- Gauntlet-side plan-to-implement compaction; tracker-state safety under compaction; the three unexplained August delta-flush records.
