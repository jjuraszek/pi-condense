# Tool-call id collisions: positional chain drops, occurrence identity, orphan sweep

Issue: [jjuraszek/pi-condense#8](https://github.com/jjuraszek/pi-condense/issues/8) (issue #9 merged in as section B).

## Problem

Provider tool-call ids are unique only within one response. `pi-ai` passes them through verbatim (Google mints its own, `api/google-generative-ai.js:136`), and github-copilot/kimi-k3 restarts a `${tool}_${n}` counter, so `bash_23` recurs inside one session. pi-condense treats those ids as session-durable identity in two places, producing one fatal and one silent failure.

**Fatal.** `applyChainCompressions` (`src/chain-range-prune.ts:61-119`) unions every `ChainCompressionEntry.droppedToolCallIds` into one session-wide `Set<string>` and then drops *any* message in the array whose id is in that set - with no positional bound. `:104-110` drops an entire assistant message when **any** of its `toolCall` ids matches. `pi-ai`'s `insertSyntheticToolResults` repairs orphan tool *calls* only, never orphan tool *results*, so the provider rejects the request, and every retry rebuilds the identical broken context. The session is unrecoverable without hand-editing the JSONL. Risk grows with session length - worst on exactly the long sessions pi-condense targets.

Provider rejection wording varies while the defect is identical: Anthropic returns `400 unexpected tool_use_id found in tool_result blocks`; Kimi K3 returns `400 Kimi K3 tool messages need a resolvable tool name: carry `tool`/`name`, or match a preceding assistant tool_call by order` - i.e. it fails to resolve the name of a tool message that matches no preceding `tool_call` **by order**, which is an orphan result by another name. Any orphan-result check must therefore be provider-agnostic and structural, not keyed to one error string.

**Why this is a code defect, not an observed-once anomaly.** The drop test is `dropped.has(id)` evaluated over the entire message array, and `:104-110` removes an entire assistant message when any single one of its `toolCall` ids matches. Nothing bounds the match to the compressed range. Therefore *any* recurrence of a dropped id later in the session deletes a live turn, and whether that turn's siblings survive orphaned depends only on whether the live assistant also carried a non-dropped id. Reuse frequency sets the blast radius; the defect is unconditional.

**Observation (no longer reproducible).** A live 2.5.0 kimi-k3 session that failed with the Kimi wording was inspected mid-incident and showed id reuse at scale (one id recurring across hundreds of tool results) plus one orphan result in the pruned view. That session, and every other affected one, was subsequently **repaired in place** - the repair rewrote ids to be unique and removed the orphan - so the pre-repair bytes are gone and those figures cannot be re-derived. They are recorded here as provenance only and **no acceptance criterion depends on them**; the case for the fix rests on the code reading above plus the constructed fixture in Testing. Post-repair, the same file replays cleanly through the shipped `pruneMessages` (1731 -> 1660 messages, zero orphans), which is expected: with unique ids the current logic and a positional range coincide.

**Silent.** The same ids key `ToolCallIndexer.index` (`src/indexer.ts:77`), `contentHashToOriginal` dedup (`:81-82`), the summarized-set check in `pruneMessages` (`src/pruner.ts:74`), and batch-capture result matching (`src/batch-capture.ts:36` first-wins live, `:73-78` last-wins on rescan). A colliding id therefore stub-replaces a live result with a stale `tN`, skips capture of a live batch, resolves `context_tree_query` to the wrong batch, and can alias unrelated content in dedup. The session keeps running on fabricated recovery data with no error.

## Goals / non-goals

Goals: remove the fatal path; make record identity collision-safe; add a last-resort orphan invariant. All three land in one branch (issue #8: "land together").

Non-goals, decided:

- **No human intervention anywhere in the repair path.** The orphan sweep repairs unconditionally at render time - no prompt, no `/pruner` confirmation, no gate. The only alternatives at that point are "drop the orphan" or "send a request that 400s"; there is nothing a user could usefully decide, and the condition is not explainable in situ. The human sees a counter after the fact.
- No id rewriting at capture time. pi-condense does not own session ids, and `pi-ai` re-normalizes them per target model anyway.
- No migration and no re-summarization of existing sessions.
- No new config key.
- Filing the upstream `pi-ai` ask (repair orphan tool *results*, not only orphan tool *calls*) is out of scope here; this spec's sweep is defense in depth and is not contingent on it.

## Design

### A. Chain drops become positional (`src/chain-range-prune.ts`)

The range information already exists - `detectChains` (`src/chain-detector.ts:36-108`) emits `{ startUserTimestamp, middleToolCallIds, protectedToolCallIds, finalAssistantTimestamp }`, and `droppedToolCallIds` is only a denormalization of the middles. The drop decision moves back onto positions.

`resolveRange(entry, messages): { startIndex, endIndex } | null`:

- `startIndex` = index of the **user-role** message with `timestamp === entry.startUserTimestamp`; `endIndex` = index of the **assistant-role** message with `timestamp === entry.finalAssistantTimestamp`. Role-gating is required, not cosmetic: the incident session has two `toolResult`s sharing millisecond `1786533716958`, and a role-less scan would read cross-role timestamp equality as ambiguity and disable compression. This mirrors the existing role-gated insertion lookup at `chain-range-prune.ts:94-97`.
- **Exactly one match on each boundary, and `startIndex < endIndex`, or the result is `null`.** More than one match is treated as unresolvable, not disambiguated: strictest reading of "resolve or drop nothing", and no rule can over-drop. Cost of a duplicated boundary timestamp is that the chain's compression is disabled until it is re-detected (context regrows for that range), made visible by a diagnostic rather than silent.
- `entry.finalAssistantTimestamp === null` (interrupted chain) is unresolvable by definition. `selectEligible` (`src/chain-compressor.ts:28-29`) already filters those out of eligibility, but the persisted type permits `null` and old entries exist, so the explicit skip stays.
- **No id-array-wide fallback, ever.** Failing closed to a no-op is the point; the previously considered timestamp-*window* variant is rejected (timestamps interleave on `/import` and forked sessions, and the incident session itself has two `toolResult`s sharing millisecond `1786533716958`).

`null` → the entry contributes nothing: no drops, and **no synthetic message inserted** (a synthetic without its range would present a summary next to the live originals).

Resolved entries contribute the half-open index range `(startIndex, endIndex)` to a `Set<number>`. Composition across entries is union-of-indices. `chain-detector` emits non-overlapping chains, but entries persist independently, so an entry whose `startIndex` falls inside another entry's dropped range is skipped (its synthetic would be dropped anyway) with a diagnostic.

Per resolved entry: the synthetic `<compressed-chain>` message is inserted immediately after `startIndex`; `endIndex` is **kept** and thinking-stripped when `stripFinalThinking`. `endIndex` is always a text-only assistant (`chain-detector.ts:96` closes a chain on an assistant message with no `toolCall`s), so keeping it cannot orphan anything.

**Drops are role-restricted: only `assistant`, `toolResult`, and `CUSTOM_TYPE_SUMMARY` messages inside a range are removed.** Two consequences, both load-bearing:

- The synthetic chain message is itself **user-role** (`chain-range-prune.ts:61-64` recovers `existingSyntheticBlockIds` by regex over user-message text). Under a blanket index drop, a second application would delete the synthetic sitting at `startIndex + 1` - inside its own `(startIndex, endIndex)` - and then `existingSyntheticBlockIds` would suppress re-insertion, silently deleting the chain body. Role restriction preserves it in place, so re-application is a true no-op (AC 5). Today's id-based drop never touches user-role messages; the restriction keeps that property.
- Third-party extensions' `custom_message` entries inside a chain range are **not** dropped. A blanket positional drop would widen today's behavior (which only removes assistant-with-dropped-id, `toolResult`-with-dropped-id, and overlapping summaries) into deleting other extensions' context. Out of scope here.

Ids stop driving drops entirely. The three id/timestamp-keyed matches inside the function become range-scoped as a consequence:

| Today | After |
|---|---|
| `perBatchSummaryOverlapsDropped` matches `details.toolCallRefs` against the dropped id set (`:11-14`) | range-scoped **coverage** check: a `CUSTOM_TYPE_SUMMARY` message whose `toolCallRefs` overlap the ids inside `(startIndex, endIndex)` is suppressed **regardless of its own index** (see the `agent-message` note below) |
| `protectedIdToBlock` resolves protected ids array-wide (`:74`) | protected ids resolved **within the entry's range only** |
| `stripFinalAtTimestamp.has(msg.timestamp)` strips any assistant sharing a millisecond (`:110`) | strip at the resolved `endIndex` |

Pure index membership would be insufficient for the first row: under `batchingMode: "agent-message"`, `flushPending` runs at agent-message end, i.e. *after* `finalAssistantTimestamp`, so the per-batch summary is appended **outside** `(startIndex, endIndex)`. Today's id-overlap check drops it; an index-only rule would keep it, leaving both the old per-batch summary and the new chain synthetic in context. The coverage check preserves today's behavior for a shipped config mode.

Ids remain in use for summary text, `tN` refs, per-batch summary coverage, and the `droppedToolCallIds` cross-check (below).

### B. Occurrence identity for records (`src/indexer.ts`, `src/batch-capture.ts`, `src/types.ts`)

Records are keyed by an occurrence key, `` `${toolCallId}@${resultTimestamp}` ``, instead of the bare provider id.

The discriminant is the **`toolResult` message timestamp** (`ToolResultMessage.timestamp`, required per `@earendil-works/pi-ai/dist/types.d.ts:318`). It is the one piece of identity material readable identically on both sides: `pruneMessages` has the `toolResult` message in hand at `src/pruner.ts:74`, and capture has the matched result message.

The existing `ToolCallRecord.timestamp` is **not** usable: the live path stamps it `Date.now()` (`index.ts:721`) while the branch-rescan path uses the session entry / message timestamp (`src/batch-capture.ts:132`), so it cannot be re-derived from context. Hence a new field rather than reuse.

Residual collision: the same provider id on two results persisted in the same millisecond. Accepted - it requires id reuse *and* a sub-millisecond coincidence, and an occurrence-ordinal alternative (k-th occurrence in branch order, recomputed per render) was rejected as a materially larger diff for that margin.

Surfaces changed:

- `src/types.ts`: `CapturedToolCall.resultTimestamp?: number`, `ToolCallRecord.resultTimestamp?: number` (persisted in `context-prune-index`, optional so pre-upgrade entries stay readable). **Also `SummaryToolCallRef.resultTimestamp?: number` (`:613-616`) and `DedupAliasEntryData` (`:603-607`) gaining `newResultTimestamp?`/`originalResultTimestamp?`** - without these the occurrence-keyed maps cannot survive a restart: `tN` aliases live only in the summary message's `details.toolCallRefs`, so `registerSummaryRefs` would rebuild `t5 -> bash_23` while the index holds `bash_23@ts`, and `resolveToolCallId("t5")` would miss. `buildShortToolCallRefs` / `makeSummaryDetails` propagate the field; `registerSummaryRefs` and the dedup-alias rebuild key by occurrence key.
- `src/batch-capture.ts`: both capture paths record the matched result's `timestamp`; the `isSummarized` check at `:119` passes the occurrence key. **The rescan path's pairing changes**: `captureUnindexedBatchesFromSession` currently builds one branch-wide `Map<toolCallId, ToolResultMessage>` (`:73-78`, last-wins), so with two `bash_23` calls the *earlier* assistant's call is paired with the *later* turn's result - a fabricated record that occurrence keys make distinct but no less wrong. Pairing becomes positional: for each assistant message, scan forward to the next assistant message and match its `toolCall` blocks against the `toolResult`s in that span. The live path's first-wins pairing (`:36`) already operates within a single turn and is unchanged.
- `src/indexer.ts`: an `occKey(id, resultTimestamp)` helper; `index`, `contentHashToOriginal`, `dedupAliasToOriginal`, `aliasToToolCallId`/`toolCallIdToAlias`, and `summaryBodies` refs are keyed by occurrence key. `tN` aliases stay 1:1 with occurrences and remain the primary recovery handle. `isSummarized` / `getRecord` accept an occurrence key, a `tN`, or a bare id.
- `src/pruner.ts`: computes `id@msg.timestamp` for each `toolResult` before the `isSummarized`/`getRecord` pair, and for `getShortRefForToolCallId` at `:88`. **The bare-id fallback is fail-closed**: it applies only when the message carries no `timestamp` (legacy shape). When `msg.timestamp` is present and `id@timestamp` is absent from the index, `isSummarized` returns **false**. A permissive fallback would stub a live `bash_23` result because an *older* `bash_23` was summarized - exactly the silent failure AC 7 forbids.
- `src/chain-compressor.ts`: `chain.middleToolCallIds` are bare ids, and `:99-111` feeds them to `hasPerBatchSummaryCoveringAny` / `getToolRefsForToolCallIds` / `getPerBatchSummariesForToolCallIds`, which now live in occurrence-key space - bare lookups would find nothing and every chain would be skipped with empty `toolRefs`. `ChainRange` gains an in-memory `middleOccurrenceKeys: string[]` collected during the same detection walk; the three lookups take it. `middleToolCallIds` stays bare (the recovery-grace filter at `:34` is untouched); the persisted `ChainCompressionEntry.droppedToolCallIds` shape gains a companion field for the same reason - see "`droppedToolCallIds` becomes diagnostic-only" below.
- `src/spill.ts`: dedup registration (`:56-58`) uses occurrence keys. `blobPathFor` (`:16-17`) names sidecars from the sanitized **occurrence key**, so two occurrences of one id cannot overwrite each other's blob; recovery falls back to the legacy bare-id path when the occurrence-keyed file is absent.
- `index.ts:106`: the pending-capture filter's `isSummarized(tc.toolCallId)` passes the occurrence key.
- `src/tree-browser.ts:122`: `getRecord(ref.toolCallId)` resolves via the `SummaryToolCallRef`'s occurrence key.
- `src/query-tool.ts`: a bare id that matches more than one occurrence returns **all** matches, chronological, one `## toolRef:` block each. No newest-wins pick, no error-out: `tN` is the primary path, raw ids are the documented fallback (`src/query-tool.ts` tool description), collisions are rare, and each block is already truncation-bounded. Bare-id multi-match is as likely as id reuse itself, which is the premise of the issue - so the honest answer is all of them.
- `src/commands.ts`: the lookup at `:1014` follows the same resolution.

### C. Orphan sweep (`src/pruner.ts`)

A final post-condition after all three existing phases: a single forward pass with **per-turn** open-call tracking. Walking the array, an assistant message *replaces* the open set with its own `toolCall` ids; each matching `toolResult` consumes its id; a `toolResult` whose id is not open at that point is an orphan and is removed. O(n).

The open set must not be session-cumulative. With one global seen-id set, an id used *validly* in an early turn stays "open" forever, so a later genuine orphan carrying that same id passes the check - which is precisely the collision case this spec exists for.

This is exactly the incident's shape (live assistant dropped, its sibling's result left behind), and it also covers orphans A cannot reach: `pi-ai`'s `transform-messages.js` skips assistants with `stopReason === "error" | "aborted"` while keeping their results.

A and C are not substitutes and the split of duties is exact: **A prevents the deletion of live turns; C prevents a deletion (from any cause) from being fatal.** C alone would have turned the observed incident into a legal request over a gutted context - failure with no error, which is worse to diagnose. A alone would leave the `stopReason === "error" | "aborted"` orphan path unhandled.

Synthetic `"No result provided"` results injected by `insertSyntheticToolResults` have a matching `toolCall`, so the sweep leaves them alone.

**Cache-prefix neutrality (load-bearing).** `doc/specs/2026-08-04-pruner-noop-serialization.md` pins two invariants: `pruneMessages` never mutates its input in place, and a no-op render returns the *same array reference* with `pruned: false` - that is what keeps the prompt-cache prefix byte-identical across renders. The sweep pre-scans and, finding no orphan, returns `messages` unchanged: no `.map()`, no re-serialization, `pruned` untouched. When it does fire it changes the prefix once, which is acceptable (the alternative is a fatal request); rewriting the prefix every turn to carry bookkeeping is not.

### Diagnostics

Three conditions report out-of-band: `unresolved-range` (A: unresolvable/ambiguous boundary, or skipped overlapping entry), `range-id-mismatch` (the `droppedToolCallIds` cross-check below), `orphan-sweep` (C fired).

Channel: one new session entry type `context-prune-diagnostic` (`CUSTOM_TYPE_DIAGNOSTIC`, `DiagnosticEntryData { kind, detail }`) plus in-memory counters shown in the `/pruner` status line. Like every `context-prune-*` type except `-summary`, it is **not** in LLM context: zero tokens, zero prefix change, and it survives a restart so a user reporting a recurrence has evidence. Steering a warning into context is rejected (invalidates the cache prefix and spends tokens on a condition the agent cannot act on); `console.warn` alone is rejected (leaves no record).

Diagnostics are deduped per `(blockId, kind)` per session, so a permanently unresolvable entry writes one entry, not one per render. `orphan-sweep` has no `blockId`; its dedup key is `("orphan-sweep", hash of the sorted swept ids)`, so a recurring identical sweep writes once per session while a *new* orphan shape still reports.

### `droppedToolCallIds` becomes diagnostic-only

The boundary timestamps A needs are *already* persisted on `ChainCompressionEntry` (`src/types.ts:422-459`), so old entries resolve to ranges with no migration and no re-summarization. That leaves the id array with no role in dropping.

It is kept, still written by `compressEligible`, and **consumed as a cross-check**: after resolving a range, compare the ids actually dropped against the persisted array; on mismatch emit `range-id-mismatch` with both counts. The range always wins - the check never changes what is dropped. This keeps `droppedToolCallIds` itself untouched (smallest diff, no writer/test churn for that field) while making it earn its place by detecting boundary-resolution drift. A benign mismatch class exists (ids the persisted array picked up from a duplicate-id collision), so this is an inspection signal, not an error. The field's doc comment is demoted accordingly.

### `ChainCompressionEntry` gains `droppedOccurrenceKeys` (persisted)

The cross-check above is the only thing that still needs `droppedToolCallIds` at render time. The *synthetic chain body* needs something else: `chainSummaryText` (`src/pruner.ts:154-155`) looks up per-batch summary text via `indexer.getPerBatchSummaryTextForToolCallIds`, and that lookup is occurrence-keyed (section B) - `summaryBodies` entries are stored under `id@resultTimestamp`, not the bare id. A bare-id lookup at render time would either miss entirely (empty synthetic body on restart) or, worse, hit a *different* occurrence of a reused id and splice an unrelated batch's summary into this chain - the exact collision this spec's section B exists to prevent. Session-only (in-memory) `middleOccurrenceKeys` is not enough: it does not survive a restart, and `droppedToolCallIds` is all that gets replayed from `context-prune-chain` entries into the chain registry.

`ChainCompressionEntry` therefore gains a second optional field, written alongside `droppedToolCallIds`:

- `droppedOccurrenceKeys?: string[]` - the occurrence keys (`id@resultTimestamp`) for the same calls as `droppedToolCallIds`, populated from `chain.middleOccurrenceKeys` at compression time (`src/chain-compressor.ts`) and persisted on the same `context-prune-chain` entry.
- Read at render time by `src/pruner.ts` (`chainSummaryText`) and by `src/commands.ts` (`/pruner compact` re-summarization lookup): both prefer `entry.droppedOccurrenceKeys ?? entry.droppedToolCallIds`, falling back to the bare-id array when the new field is absent.
- **Additive and backward-compatible.** Optional, so pre-upgrade `context-prune-chain` entries - persisted before this field existed - deserialize unchanged and simply take the fallback arm: they look up their own summary bodies by bare id, which is correct for them because those bodies were themselves stored bare-keyed (an entry from before occurrence keying shipped never has an occurrence-keyed sibling to collide with).
- The cross-check in the previous section still reads `droppedToolCallIds` only - `droppedOccurrenceKeys` has no diagnostic role, it exists purely to make the synthetic-body lookup resolve correctly after a restart.

This supersedes the "persisted shape untouched" framing used when `droppedToolCallIds` was demoted to diagnostic-only above (and in section B's summary of `src/chain-compressor.ts` changes): that statement is true of `droppedToolCallIds` itself, not of `ChainCompressionEntry` as a whole, which gains this one companion field.

## Data flow

**Capture (`turn_end`).** `captureBatch` pairs each assistant `toolCall` with its `toolResult` and stores that result's `timestamp` on the `CapturedToolCall`. `addBatch` keys the record `id@resultTimestamp`, mints/reuses the `tN` alias against that key, persists both in `context-prune-index`. Dedup compares content hashes as today but stores occurrence keys on both sides, so a repeated id can no longer alias an unrelated call.

**Render (`pruneMessages`).** Phase order unchanged. Phase 1 computes each `toolResult`'s occurrence key for the summarized/record lookups. Phase 3 resolves ranges positionally, unions index ranges, inserts synthetics after each `startIndex`, strips thinking at each `endIndex`. Then the sweep runs once over the result.

**Chain compression.** `compressEligible` keeps its shape and both entry points (`flushPending`, `/pruner compact` via `src/commands.ts:995-1026`) are unaffected, but its three indexer summary lookups take `middleOccurrenceKeys` instead of bare `middleToolCallIds` (section B).

**Rebuild (`session_start`).** Index/alias/dedup replay from persisted entries; entries lacking `resultTimestamp` key by bare id, i.e. today's behavior. Chain entries replay as today.

## Edge cases

- **Unresolvable / ambiguous boundary, `finalAssistantTimestamp === null`, boundary message absent** → zero drops, no synthetic, one deduped `unresolved-range` diagnostic.
- **Overlapping entries** → union of indices; an entry starting inside another's dropped range is skipped with a diagnostic.
- **Legacy records** (pre-upgrade, no `resultTimestamp`) → bare-id keyed; a session spanning the upgrade retains today's mis-key risk for its older half: a live tool result whose provider id collides with a pre-upgrade summarized record can be stub-replaced with that record's stale content via the `hasLegacyBareRecord` fallback in `src/pruner.ts`. Accepted explicitly: no migration, no re-summarization. New (occurrence-keyed) records are unaffected.
- **Idempotency** → the existing `existingSyntheticBlockIds` pre-scan (`chain-range-prune.ts:56-58`) stays, and because drops are role-restricted the already-inserted user-role synthetic survives inside its own range, so a second application yields the identical output. The sweep is a pure function of its input.
- **Mixed batching modes** → a session that switched `batchingMode` mid-flight holds per-batch summaries both inside and outside chain ranges; the coverage check suppresses both.

## Testing

`bun test src/`, colocated `*.test.ts`, existing fixture style (plain messages with explicit `timestamp`s; `entry()` helper for persisted chain entries). Fixtures without timestamps gain them - "existing tests pass unchanged" is explicitly **not** an acceptance criterion.

- **#8 regression, failing-first**, constructed to the shape the code defect permits (two compressed chains, then a live turn reusing a dropped id alongside a fresh one). Fully specified here; no incident artifact is needed to write it:

  ```
  0  user       ts=1000                       <- chain b5 start
  1  assistant  ts=1100  toolCalls[bash_18]
  2  toolResult ts=1150  bash_18
  3  assistant  ts=1200  (text only)          <- chain b5 end
  4  user       ts=2000                       <- chain b7 start
  5  assistant  ts=2100  toolCalls[bash_23]
  6  toolResult ts=2150  bash_23
  7  assistant  ts=2200  (text only)          <- chain b7 end
  8  user       ts=3000                       <- live turn, no chain entry
  9  assistant  ts=3100  toolCalls[bash_23, gauntlet_setting_24]   <- id reuse
  10 toolResult ts=3150  bash_23
  11 toolResult ts=3160  gauntlet_setting_24
  ```

  Entries: `b5 = {start 1000, final 1200, dropped [bash_18]}`, `b7 = {start 2000, final 2200, dropped [bash_23]}`. Pre-fix, indices 9-10 are deleted and 11 survives orphaned. Post-fix: 9, 10, 11 all survive; only 1-2 and 5-6 are dropped.
- `resolveRange`: unique match; duplicate boundary timestamp; `finalAssistantTimestamp === null`; `endIndex <= startIndex`; missing boundary message - each "drop nothing, no synthetic", each with its diagnostic.
- Positional replacements for the id-based assertions: protected-output relocation (`chain-range-prune.test.ts:422-443`, `:448-510`), per-batch summary suppression (both inside and after the range), thinking strip at `endIndex`, overlapping-entry skip, role restriction (a third-party `custom_message` inside a range survives).
- Occurrence identity (issue #9's AC set): two batches both containing `bash_23` keep both records recoverable and each `tN` returns its own batch's output; a live result colliding with a summarized id is not stub-replaced (fail-closed fallback); a live batch colliding with summarized ids is still captured and summarized; content-hash dedup does not alias across batches that merely share a colliding id; branch rescan pairs each turn's calls with its own results; `session_start` rebuild reproduces both colliding records *and* both `tN` aliases via summary refs and dedup aliases; two spilled occurrences of one id get distinct sidecar paths, and a legacy bare-id blob still resolves.
- `query-tool`: bare id with two occurrences returns both blocks, chronological.
- **Orphan invariant as one shared helper** ("no `toolResult` survives without its `toolCall`"), applied across the chain/prune cases rather than restated per test.
- Sweep: fires on a hand-built orphan and emits its diagnostic; clean input returns the **identical** array (`toBe`, not `toEqual`) so the cache/no-op guarantee is pinned by a test; a fixture-wide assertion that the sweep fires **zero** times across every existing chain/prune fixture - it is a net, not a crutch.
- Idempotency: applying the same `ChainCompressionEntry[]` twice is a no-op.
- Rebuild from `context-prune-index` entries lacking `resultTimestamp` → id-only keys, today's behavior.

Plus the repo's `tsc --noEmit` invocation (AGENTS.md) and an end-to-end smoke run (`pi -e ./index.ts --no-extensions -p ...` against an isolated `$PI_CODING_AGENT_DIR`), checking that `context-prune-diagnostic` entries appear and do not appear as expected.

**No replay against a real incident session is possible or required.** Every affected session was repaired in place (ids rewritten unique, orphans removed), so no artifact reproduces the failure; the constructed fixture above is the sole regression vehicle. A repaired session remains useful as a **non-regression** check only: replaying one through the new `pruneMessages` must leave its orphan count at zero and must not drop more messages than the persisted chain ranges cover.

## Acceptance criteria

Issue #8's own AC section is empty (two headings, `Drop path:` and `Identity:`, no bullets; part C has no heading at all). These are the criteria for this change.

Drop path:

1. A live assistant turn whose tool-call id collides with a dropped chain id survives the render intact, together with all of its tool results (failing-first constructed fixture; no real-session artifact is required, and none exists).
2. Chain drops are decided by index range only; no chain code path drops or strips by id-set or timestamp membership without a positional bound. The part C orphan sweep is excepted - it is an id/ordering invariant by construction, not a range rule.
3. Unresolvable or ambiguous boundaries, and `finalAssistantTimestamp === null`, drop nothing and insert no synthetic; no id-array-wide fallback exists.
4. `perBatchSummaryOverlapsDropped`, protected-output relocation, and final-thinking strip are each range-scoped and each has a test; per-batch summary suppression also holds when the summary sits *after* `endIndex` (`batchingMode: "agent-message"`).
5. Re-applying the same `ChainCompressionEntry[]` is a no-op, including preservation of the already-inserted synthetic chain message.
5a. Only `assistant`, `toolResult`, and `CUSTOM_TYPE_SUMMARY` messages are dropped from a range; user-role and third-party `custom_message` entries inside the range survive.

Identity:

6. Two batches that both contain `bash_23` keep both records recoverable, and `context_tree_query` on each `tN` returns its own batch's output.
7. A live tool result whose id collides with a summarized id is not stub-replaced.
8. A live batch whose ids collide with summarized ids is still captured and summarized.
9. Content-hash dedup does not alias across batches that merely share a colliding id, and two spilled occurrences of one id do not share a sidecar path.
10. `session_start` rebuild reproduces both colliding records **and both `tN` aliases** (summary refs and dedup aliases included); entries without `resultTimestamp` fall back to bare-id keys.
10a. Branch rescan pairs each assistant's tool calls with the results of its own turn, so a colliding id cannot pair an earlier call with a later result.
10b. A live tool result carrying a `timestamp` with no occurrence-keyed record is treated as *not* summarized (fail-closed), even when an older occurrence of the same bare id was summarized.
11. `context_tree_query` with a bare id matching multiple occurrences returns every match, chronologically.

Orphan post-condition:

12. A rendered array never contains a `toolResult` without a preceding surviving `toolCall`, asserted via one shared helper across cases. The check is structural and provider-agnostic: it must not branch on any provider's error string (see Problem section for why Anthropic's and Kimi K3's rejections are the same defect).
13. The sweep fires zero times across all existing chain/prune fixtures, and its open-call tracking is per-turn (an id validly used earlier does not license a later orphan).
14. A render in which the sweep does not fire returns the identical input array reference (`toBe`) with `pruned` unchanged.
15. Every diagnostic condition writes a `context-prune-diagnostic` session entry and increments a `/pruner` status counter; none of them adds anything to LLM context.

## Provenance

Two incidents, same defect, both on pi-condense 2.5.0:

1. The session referenced in issue #8 (`400 unexpected tool_use_id found in tool_result blocks`). Its JSONL is hand-edited-during-recovery and was not retrievable via `gh issue view --json body,comments`; provenance only.
2. A `gridstrong` session that failed with `400 Kimi K3 tool messages need a resolvable tool name: carry `tool`/`name`, or match a preceding assistant tool_call by order` - the Kimi wording for an unmatchable (orphan) tool message. Inspected mid-incident, then repaired in place, so its pre-repair state is unrecoverable.

**No incident artifact survives**: all affected sessions were repaired in place, which rewrote tool-call ids to be unique and removed orphans. Nothing in this spec depends on one - the constructed fixture in Testing is self-contained, and the acceptance criteria are stated against it.

## Open questions

None open. (The raw incident JSONL would add nothing beyond the minimized fixture; if it later surfaces, it is a cross-check, not a prerequisite.)

## Documentation impact

Materiality bar: `pi-gauntlet/skills/brainstorming/reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` (range drop is positional; identity is occurrence-keyed; orphan sweep and its cache-neutrality), `README.md` (`/pruner` status diagnostic counters, `context_tree_query` bare-id multi-match), `CHANGELOG.md`
- Derived / memory docs invalidated: `AGENTS.md` customTypes table (new `context-prune-diagnostic` row; the `context-prune-chain` row's id-drop wording)
