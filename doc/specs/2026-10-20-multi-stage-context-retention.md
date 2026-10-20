# Multi-stage context retention: argument purge and range-aware supersession

**Goal:** A long multi-stage session (a pi-gauntlet brainstorm -> plan -> implement run) stops carrying two kinds of content that no longer serve the current stage: the large arguments of tool calls whose results have already been summarized (subagent task prompts, 5-40k chars each) and the chunks of an over-cap protected file that a path-only supersession rule stubs even though no later read covers them. Both changes extend existing phases (2 argument purge, 1b supersession) with no new config keys, no new session entry types, and no extra prompt-cache rewrite moments.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.

Supersedes `doc/specs/2026-09-07-protected-path-supersede.md`, decision (a) "identity is `args.path`; `offset`/`limit` ignored" only; its stub text, cadence (floor) rule, and `activated` stickiness stay live.

## Problem

Gauntlet sessions in two consumer repos plateau at 280-740k context. Measured on three sessions (10-19, 10-20): protected skill reads retained verbatim are 206-378k chars after supersession (reference/*.md are 40-100k of that); subagent tool-call arguments are 135-607k chars; 93 of 214 budget-triggered flushes in the longest session ended `skipped-trivial`. The session JSONLs are not in this repo, so the figures are the user's measurement, not reproduced here.

Verified premises:

- Supersession keys on `normalizePath(args.path)` only (`src/supersede.ts:62-70`); `offset`/`limit` are ignored by decision (a) of the 2026-09-07 spec and pinned by `src/supersede.test.ts:45-48`. A file over pi's `read` cap (50 KB or 2000 lines, `dist/core/tools/truncate.js`; `offset` 1-indexed, `limit` in lines, footer "Use offset=N to continue") arrives as 2-3 reads of one path, and every chunk but the last is stubbed with "Re-read the file if this earlier content is needed" - which the model does (one SKILL.md read 4x in a session).
- Corrected premise: subagent arguments are not unreclaimable by construction. Phase 3 (`src/chain-range-prune.ts`) drops the middle assistant turns of a closed chain, arguments included, once it falls outside the rolling window of 3 closed chains. What no phase does is touch the arguments of a successful call while its chain is open or among the last 3 closed chains; `src/error-purge.ts` rewrites errored calls only. A gauntlet questionary is one chain until a text-only assistant turn, so the operating assumption is "arguments stay in the last few chains for the rest of the stage"; which case the measured sessions hit is unverified.
- The index record carries the call's arguments unclipped (`src/batch-capture.ts:110` -> `src/indexer.ts:489`, persisted in `context-prune-index`), and `context_tree_query` already prints them as `Args:` before the result (`src/query-tool.ts:67`). Recovery of purged arguments needs no new surface.
- `**/skills/**/*.md` matches `reference/*.md` by design (spec 2026-06-11), and pi-gauntlet's brainstorming skill states that every skill resource is loaded with `read` because "pruning protection keys on `read`'s `path`" - a cross-repo contract.
- `skipped-trivial` means every batch in the flush was under `minBatchChars` (2000); the results cost no LLM call and stay verbatim until chain compression. The gate sums `resultText` only (`index.ts` `batchRawChars`), so a subagent call with a 40k prompt and a sub-2000-char result lands in a trivial batch, is never indexed, and is never stubbed. Change 1 therefore reclaims only the arguments of indexed calls: trivial batches, protected calls, and dedup aliases are excluded. How much of the measured 135-607k sits in trivial batches is unmeasured (see Open questions).
- Cache cadence: the 2026-08-05 thinking-strip removal and the 2026-09-07 floor rule both exist because a rewrite on its own schedule busts the prompt-cache prefix every turn. Error purge's `cooldownTurns` is such a schedule, tolerated because errors are rare.

Implicit dependencies: pi `read` offset/limit semantics - checked in `pi-coding-agent/dist/core/tools/read.js` and `truncate.js` - found. Error-purge shrink routine (strings over 200 chars -> marker, keys and types kept) - `src/error-purge.ts` - found. Unclipped args in the index record - `src/batch-capture.ts:110` - found. Measured session JSONLs - not checkable (not in repo).

Framing: kept. Checked `supersede.ts`, `protected.ts`, `chain-detector.ts`, `chain-range-prune.ts`, `chain-compressor.ts` `selectEligible`, `error-purge.ts`, the `index.ts` trivial filter, and the pi read tool; the scout's "chain closure valve" objection yields no alternative without new machinery and stays a lead (see Out of scope).

## Acceptance criteria

none - no ticket

## Design

### Decisions from the questionary

| Question | Decision |
|---|---|
| Large arguments of a summarized call | Phase 2 generalizes: an indexed call whose result phase 1 stubs loses its long string arguments in the same render; recovery via `context_tree_query`, which prints `Args:`. Dedup aliases keep their arguments: the index stores only the canonical record's args, so an alias's own prompt would not be recoverable |
| Chunked reads of one path | Range-aware supersession: a later read supersedes an earlier read of the same path only when the lines it delivered cover the lines the earlier read delivered. Two identical full reads, both truncated at pi's cap, deliver the same lines, so the newer one still supersedes the older (the user's "even if overgrown" case) |
| `reference/*.md` in the protected default | Unchanged (`**/skills/**/*.md`). Narrowing is a cross-repo contract change; follow-up in both repos if post-change measurements still show references dominating. The root fix for oversized skill files stays in pi-gauntlet |
| `skipped-trivial` flushes | Unchanged; recorded as measured, not addressed. Candidate follow-up: index + stub trivial batches without an LLM call |
| Where the argument shrink lives | Render time in the pruner (approach 1), following the render-time positional convention of supersession and error purge. A persisted marker on the summary entry (approach 2) was rejected as a new field with two places that must agree, for a stability benefit nobody needs. A size-only rule for every call (summarized or not) is not viable: trivial and protected calls have no index record, so no recovery path |

### One-line rule (for PRUNING.md)

An indexed call whose result has been summarized loses its long string arguments in the same render its result is stubbed; `context_tree_query` returns both the arguments and the result.

Two existing exceptions stay separate from that line: an errored call is shrunk after `cooldownTurns` whether or not it was indexed (today's behavior), so `context_tree_query` recovers its arguments only when the call was also indexed; and a dedup alias is never shrunk (its own arguments are not in the index).

### Change 1: phase 2 becomes argument purge

`purgeErroredArgs` today (`src/error-purge.ts`) runs two passes: pass 1 collects the toolCallIds of errored results with the assistant turn index that issued them; pass 2 walks assistant messages and, for each matching toolCall older than `cooldownTurns` whose JSON body is at least `minArgChars`, replaces every string over 200 chars with `<purged-errored-args size="N"/>`, keeping keys, JSON types, and array lengths (2026-10-04 spec, inherited unchanged).

The extension adds one more source to pass 1: the results phase 1 stubbed in this same render. Phase 1 already resolves each stubbed result's key (`occKey(toolCallId, timestamp)` when the result carries a timestamp, the bare id otherwise) and its short ref; `pruneMessages` keeps that map (key -> ref) instead of discarding it, omits dedup aliases from it, and hands it to phase 2 alongside the messages. No record lookup into the indexer from phase 2, no second turn count. Phase 1 needs a read-only alias check from the indexer to omit aliases; stored index data and `context_tree_query` output are unchanged.

Pass 1 pairs results to calls positionally, with the per-turn open-set walk `findSuperseded` and orphan-sweep already use: each assistant turn resets the open set of its `toolCall` blocks, and a `toolResult` pairs to the open block with its id. For a paired result that is in phase 1's handoff map or carries `isError: true`, pass 1 records the exact `(assistantIndex, blockId)` of the paired block, plus the turn index for the errored source. Pass 2 rewrites only recorded positions. A timestamp-less result still resolves its handoff key by bare id, but the rewrite position comes from the pairing, so a reused provider id never authorizes a sibling block in another turn.

Rules for the summarized source:

- No cooldown. The shrink happens in the render in which the result is first stubbed, never on a later turn of its own. Every `context` render starts from raw history, so phase 2 shrinks the same summarized set on every render; the guarantee is that for a fixed index and grace state the emitted prefix bytes are equal across renders, not that the raw input comes back by reference. Returning the input array by identity is the no-change case only (nothing qualifies, or the input is already shrunk). `cooldownTurns` keeps its meaning for errored calls only. A separate schedule for summarized calls would rewrite the prefix two turns after every flush - the August pattern this spec must not reintroduce.
- Same size gates: `purgeErrors.enabled` is the toggle for both sources, `minArgChars` is the whole-body gate for both, the 200-char per-string floor and the keep-keys-and-types rule are shared. No new config key.
- Marker: `<purged-args size="N" ref="t6"/>`, where `ref` is the short ref phase 1 put in the result stub, so the recovery handle sits in the argument itself. Errored calls keep `<purged-errored-args size="N"/>`. One shrink routine, parameterized by marker text.
- A call that both errored and was summarized: on any render where phase 1 stubs the result, the stub carries `isError: false`, so the errored source never sees it and the summarized marker is written. If `cooldownTurns` expired before the flush, earlier renders wrote `<purged-errored-args>`; the stub render then selects the summarized marker instead, which coincides with the rewrite phase 1 already makes at that position. No claim that the stub render comes before cooldown expiry.

Not touched: protected calls (phase 1 never stubs them), trivial batches (no index record, no stub), results inside the recovery grace window (stubbed and shrunk together once the window passes - one rewrite, as today), dedup aliases (phase 1 keeps stubbing their results as today, but they are omitted from the handoff: dedup hashes tool name and result text only (`src/content-hash.ts`), `registerDuplicate` stores no alias arguments, and `context_tree_query` on the shared ref prints the canonical record's args - two subagent calls with different prompts and equal output would otherwise lose the second prompt), and chain compression, which keeps dropping whole turns and finds the arguments already small. Sessions resumed from before this change: phase 1 stubs every indexed result on the first render after `session_start`, and the arguments shrink in that same rewrite; the supersession floor is phase 1b's gate and plays no part here.

### Change 2: range-aware supersession

`findSuperseded` (`src/supersede.ts`) groups protected reads by normalized path and marks every occurrence but the last as a candidate. It will instead derive the delivered line range per occurrence and mark an occurrence superseded only when a later occurrence on the same path covers it:

- Requested range. Numeric `offset` normalizes to `max(1, offset)`, matching pi's read (`offset ? Math.max(0, offset - 1) : 0` in `dist/core/tools/read.js`: 0, 1, and negatives all start at line 1). `offset` absent, `null`, or non-numeric -> start 1. Numeric `limit > 0` gives `[start, start + limit - 1]`; `limit` absent, `null`, or non-numeric -> open end `[start, inf)`. `limit <= 0` delivers no lines (pi slices an empty range): that occurrence covers nothing, never supersedes anything, and is covered by any later read of the path.
- Delivered range. pi appends `[Showing lines S-E of T ... Use offset=N to continue.]` to the result text when the 2000-line or 50 KB cap truncates the output; `findSuperseded` already has the paired result in hand, so it bounds the occurrence's end at `E` when that footer is present. A result that is pi's oversized-first-line warning (`[Line N is <size>, exceeds <size> limit. Use bash: ...]`, emitted instead of content) delivers no lines, like `limit <= 0`. Otherwise, without the footer the delivered range is the requested range. The same bound applies to the earlier occurrence: a `limit: 2500` chunk that was byte-capped at line 1800 delivered `[start, start + 1799]`, not 2500 lines.
- A later read covers an earlier one when its delivered start is at or below the earlier delivered start and its delivered end is at or above the earlier delivered end. Chunks the later read did not deliver stay verbatim. Non-numeric values degrade toward "covers everything", which is the pre-change behavior.
- Ranges on different normalized paths never interact. Coverage is checked against each later occurrence of the path, not only the last one.

The result table (file of 3000 lines; "capped" means pi truncated the output):

| Sequence on one path | Superseded |
|---|---|
| full, full | first |
| chunk `1-2000`, chunk `2001-` | none |
| chunk `1-2000`, full capped at line 2000 | chunk (delivered ranges equal) |
| chunk `2001-3000`, full capped at line 2000 | none (the later read never delivered the tail) |
| full, chunk | none |
| chunk 1, chunk 2, chunk 1 again | first chunk 1 |
| full capped at line 2000, full capped again | first (same delivered lines; the user's "even if overgrown" case) |
| `limit: 2500` byte-capped at line 1800, full capped at line 2000 | first (`[1, 1800]` is inside `[1, 2000]`) |
| full capped at line 2000, `limit: 2500` byte-capped at line 1800 | none |
| `offset: 0, limit: 100`, full | first (offset 0 is line 1) |
| `offset: null` no limit, chunk `1-50` | none (`[1, inf)` is not covered by `[1, 50]`) |
| chunk `1-50`, `offset: null, limit: 50` | first (`[1, 50]` covers `[1, 50]`) |

Cadence gating through `state.floor`, stickiness through `state.activated`, the stub text, and the "which tools participate" rule (`isProtected` and `typeof args.path === "string"`) are unchanged. `src/supersede.test.ts:45-48` flips to assert that differing slices are not candidates. The delivered-coverage rule is documented in `PRUNING.md` next to the range rule so a reader does not file "a capped full read did not supersede my tail chunk" as a bug.

### Responsibilities after the change

| Module | Owns |
|---|---|
| `src/pruner.ts` | Orchestration; carries phase 1's handoff map (resolved key -> short ref, aliases omitted) into phase 2 |
| `src/error-purge.ts` | Shrink routine, both sources, positional call/result pairing, cooldown for the errored source, both markers |
| `src/supersede.ts` | Read identity including delivered-range coverage |
| `src/indexer.ts` | Gains a read-only "is this key a dedup alias" check for phase 1; stored records unchanged, args still captured unclipped |
| `src/query-tool.ts` | Unchanged; args printed on recovery |
| `src/commands.ts` | Settings overlay copy for the shared `purgeErrors` toggle and `minArgChars`: label and description say argument purge (summarized and errored sources); the cooldown row stays explicitly errored-only; persisted config keys unchanged |

### Cache and identity guarantees

- For a fixed index and grace state, the emitted prefix bytes are equal across renders of fresh raw history (each render re-applies the same stub set and shrink). Phase 2 returns the input array by identity only when nothing qualifies or the input is already shrunk: the marker is under the 200-char floor, so a repeat pass over transformed output is identity.
- No new rewrite moments: summarized-source shrink coincides with phase 1's stub render; supersession keeps its floor gate.
- Argument values change, toolCall ids and their result pairing do not, so pi-ai's orphan repair (`dist/api/transform-messages.js`) is never triggered.

## Errors and edge cases

- `purgeErrors.enabled: false` leaves both sources untouched.
- A summarized call whose JSON body is under `minArgChars`, or whose body has no string over 200 chars, is returned unchanged (same as errored today).
- The shrink reads and writes `block.arguments` (pi-ai `ToolCall.arguments: JsonObject`, `dist/types.d.ts`), as error purge does today. The `block.input ?? block.args ?? block.arguments` resolution belongs to capture and supersession and is not added to phase 2; the errored source keeps its current shrink semantics (a top-level string over 200 chars shrinks too), and no shared non-object guard is introduced.
- Sessions without result timestamps resolve the handoff key by bare id, as phase 1 does; the rewrite position still comes from the positional pairing, so no timestamp logic in the shrink.
- A protected read whose `args.path` is a string but whose `offset`/`limit` are strings (malformed call) is treated as a full read.

## Tests

`bun test src/`; every new fixture passes through `expectNoOrphanToolResults` (`src/test-support.ts`).

- `src/error-purge.test.ts`: a call in the handoff map shrinks in the same render with `<purged-args size="N" ref="..."/>` and no cooldown; the errored source still waits `cooldownTurns`; a second pass over the shrunk history returns the input array by identity; `enabled: false` leaves both; keys, types, and array lengths survive for the summarized source; two calls in different turns sharing one `block.id` where only the occurrence paired to the summarized result shrinks (the sibling keeps full arguments), for both the timestamped and the timestamp-less result.
- `src/pruner.test.ts`: a result stubbed by phase 1 has its call's arguments shrunk in the same `pruneMessages` result; a protected call, a call in the grace window, and a dedup alias (different arguments, same result text as an earlier call) keep full arguments, and `context_tree_query` on the alias's ref still returns the canonical args; marker precedence through `pruneMessages`: a render where cooldown has expired but no flush happened writes `<purged-errored-args>`, and a later render after the flush writes `<purged-args ref=.../>` for the same call; appending ordinary turns with a fixed index state leaves the already-rendered prefix bytes unchanged across renders of fresh raw history.
- `src/supersede.test.ts`: every row of the result table, including tail-then-capped-full and byte-capped-limit (the capped results carry pi's `[Showing lines S-E of T ...]` footer); `offset: 0` normalizes to line 1; `limit: 0` and a negative limit cover nothing; `{ offset: null }` with no limit is `[1, inf)`; `{ offset: null, limit: 50 }` is `[1, 50]` and does not supersede an earlier `[1, inf)` read; the former "slices supersede" pin asserts the opposite.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` § Error Purge (renamed to argument purge: the one-line rule with its errored and alias exceptions, both markers, cooldown errored-only, same-render cadence rationale - categories: operations/tunable parameters, non-obvious rationale); `PRUNING.md` § Protected tools & paths, supersession identity (delivered-range rule and the result table - category: major definitions); `PRUNING.md` pipeline diagrams and phase lists that name "error-purge" (TOC entry, the five-phase list in the live-reclaim paragraph, the two `[2] error-purge` / `[error-purge]` diagram lines) rename to argument-purge; `AGENTS.md` layout line for `src/pruner.ts` (`stub-replace -> supersede -> error-purge -> ...`) renames the phase; `doc/specs/2026-09-07-protected-path-supersede.md` (supersession banner on decision (a)); `CHANGELOG.md` - `## [Unreleased]`
- Derived / memory docs invalidated: none (`README.md` does not document `purgeErrors` today and gains nothing here; the settings-overlay copy in `src/commands.ts` is implementation surface, listed under Responsibilities)

## Out of scope

- Narrowing `protectedPaths` or any stage-aware rule for skill resources (cross-repo contract; follow-up in both repos if measurements warrant).
- Any change to the trivial-batch skip or `minBatchChars`.
- A chain-closure valve for single-chain sessions (`PRUNING.md` "Single-chain sessions"); no alternative without new machinery surfaced.
- Shrinking arguments of calls with no index record (trivial, protected).
- Stale docs flagged, not fixed here: the `types.ts` `minBatchChars` comment says default 1000 (actual 2000); `AGENTS.md` cites pi-ai `dist/providers/transform-messages.js`, actual `dist/api/transform-messages.js`.

## Open questions

- Whether the measured sessions are single open chains (few `context-prune-chain` entries) is unverified; the design works in both cases, but the reclaim figure after this change should be re-measured on the same three sessions before deciding on the two follow-ups above.
- How much of the 135-607k of subagent arguments sits in trivial batches (result under `minBatchChars`, so never indexed and never shrunk by Change 1) is unmeasured. The re-measurement above also counts subagent calls whose batch ended `skipped-trivial` and the size of their arguments. The trivial gate stays unchanged per the Q4 decision; if that share is material, whether arguments should count toward `minBatchChars` is a separate user decision, not a silent scope change here.
