# Flush-gated thinking strip (timestamp-keyed boundary)

> **Superseded by:** [doc/specs/2026-08-05-remove-thinking-strip.md](./2026-08-05-remove-thinking-strip.md) - fully

Issue: [jjuraszek/pi-condense#3](https://github.com/jjuraszek/pi-condense/issues/3) - "thinkingStrip advances its window every render, so the prompt cache falls back to tools+system on ~57% of turns".

Status: accepted (brainstorm). Target: v2.4.x. Worktree: `fix/thinking-strip-flush-gated`.

## Problem

Phase 4 of `pruneMessages` (`stripOldThinking`, `src/thinking-strip.ts`) derives its keep-window from the **live assistant count in the current array on every `context` render**. As turns advance, the `(count - keepLastTurns)`-th assistant slides forward one turn per render, so the message that falls out of the window has its thinking stripped - a mutation **deep in history**, not at the tail.

pi-ai's serializer sets prompt-cache breakpoints only at `tools + system + last message` (no in-history breakpoint). Verified in `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` `convertMessages`: `cache_control` is attached to exactly the system prompt block, the last tool definition (`index === tools.length - 1`), and the last conversation message ("Add cache_control to the last user message to cache conversation history"). A deep-history mutation therefore invalidates the entire cached suffix after `tools + system`. Because phase 4 mutates on *every* render, the cache busts on roughly every render inside a tool loop - the ~57% tools+system fallback the issue reports.

The behaviour (bounding retained thinking to the last K turns) is wanted; unbounded thinking bloats context. Only the **cadence** (per-render) and the **documented cost model** are wrong.

## Goals

- Phase 4 **does not mutate any previously-rendered historical message between flushes** - so the shared historical prefix of consecutive `context` renders is byte-stable and the cache prefix survives a tool loop. (Not "the whole array is byte-identical": a tool loop appends a new toolCall/toolResult at the tail before each render, so the arrays differ at the tail by construction; the invariant is about the *unchanged prefix*, and `error-purge` remains an independent, out-of-scope live-count mutator - see [Cache economics](#cache-economics).)
- Retained-thinking window stays anchored to `keepLastTurns` (preset semantics preserved: 4/8/16/32/64).
- No new config key.
- `PRUNING.md` "Cache impact" corrected.
- Existing 12 `thinking-strip.test.ts` tests pass unchanged.

## Non-goals (out of scope)

- **No cadence/stride knob.** The core fix already turns k-busts-per-request into 1 (see [Cache economics](#cache-economics)); a stride is a modest, workload-dependent further lever, deferred until telemetry justifies it. If ever added, it is expressed in **turns**, not messages (self-adjusts to variable request length; `keepLastTurns` is already in turns).
- **No change to default budget knobs** (`autoBudgetThreshold` / `budgetTurnDelta` stay `null`).
- **Not** reusing `PruneFrontier.lastAttemptedTimestamp` for the window (rejected in Q1 - it is a batch-capture wall-clock time at the *front* of the un-summarized region, coupled to prune progress and `rollingWindow`, unrelated to `keepLastTurns`; reusing it would deprecate `keepLastTurns`).

## Design overview

The strip boundary stops being derived per-render and becomes a **flush-computed, persisted assistant-message timestamp** that only moves forward at flushes. Everything else in phase 4 (all-or-nothing per-message strip, same-ref fast paths, order/length preservation) is untouched.

- **Compute at flush** (`flushPending`): `boundary = timestamp of the (assistantCount - keepLastTurns)-th assistant message`, over the raw session branch plus the not-yet-persisted `closingMessage`, clamped monotonic non-decreasing. Stored on the existing frontier snapshot.
- **Consume at render** (`context` handler -> `pruneMessages` -> `stripOldThinking`): strip thinking from every assistant message with `timestamp < boundary`. Between flushes the boundary is a fixed number -> byte-identical output.
- **Persist** on the existing `context-prune-frontier` entry - no new customType, no new persistence layer, no new config key.

Boundary keyed by **message timestamp**, not array index: phase 3 (`chain-range-prune`) drops middle messages, so an absolute index into a shrinking array is a landmine. Timestamp identity is the precedent phase 3 already uses (`msg.timestamp`).

## Components and signatures

Five touch points. All new params are **optional**; absent/`undefined` -> the current live-count logic runs verbatim (this is what keeps the 12 existing tests green and handles genuinely pre-first-flush and pre-feature session entries). Feature-written frontier entries must survive session reload - see `src/frontier.ts` below; without that change every resumed session drops the boundary and falls back to the buggy per-render path until its next flush.

### `src/types.ts` - one new frontier field
Add to `PruneFrontier`:
```ts
thinkingStripBoundaryTimestamp?: number;
```
Rides the existing `CUSTOM_TYPE_FRONTIER` entry. No change to `ThinkingStripConfig` (`{ enabled, keepLastTurns }`) or `DEFAULT_CONFIG`.

### `src/frontier.ts` - persist the field across reload
`PruneFrontierTracker.fromJSON` (frontier.ts:22-40, verified) reconstructs the frontier by **explicitly whitelisting** known fields, so a field added only in `types.ts` is silently dropped on every `session_start` / `session_tree` reconstruct. Add one line inside `fromJSON`:
```ts
thinkingStripBoundaryTimestamp: data.thinkingStripBoundaryTimestamp,
```
(Left `undefined` when absent, which the render path already treats as the live-count fallback.) This is a **blocker**: without it the fix regresses to the per-render bug on every resumed session, not just genuinely pre-feature ones. Requires a persist-then-`fromJSON` round-trip test asserting the field survives.

### `src/thinking-strip.ts` - boundary input + pure helper
- `stripOldThinking(messages, config, boundaryTimestamp?)` - new optional 3rd arg.
  - `boundaryTimestamp` is a `number` -> strip thinking from every assistant message with `msg.timestamp < boundaryTimestamp` (all-or-nothing per message; same same-ref fast paths).
  - `undefined` / `null` -> **fall back to the current live-count logic verbatim.**
- `computeThinkingBoundary(assistantTimestamps, keepLastTurns, prev?)` (new, pure, unit-testable):
  - Input is the ordered list of assistant-message timestamps (raw branch + `closingMessage` when it is an assistant message).
  - **Clamp `keep = Math.max(1, keepLastTurns)` before indexing** - mirrors the existing `stripOldThinking` clamp (thinking-strip.ts:25) and the locked `keepLastTurns=0` contract (thinking-strip.test.ts:99). Without it `keepLastTurns=0` indexes `assistantTimestamps[count]` (out of bounds -> `undefined`/`NaN` boundary that then gets persisted).
  - `count <= keep` -> return `prev` (nothing to strip yet; do not regress).
  - else `candidate = assistantTimestamps[count - keep]`; return `max(prev ?? candidate, candidate)` (monotonic non-decreasing = advance-only).

### `src/pruner.ts` - thread the boundary through
- `pruneMessages(messages, indexer, chainCompression?, errorPurge?, thinkingStrip?, protection?, recoveryGraceTurns=0, thinkingBoundaryTimestamp?)` - one new trailing optional param, passed straight into the phase-4 call at pruner.ts:154 (`stripOldThinking(current, thinkingStrip, thinkingBoundaryTimestamp)`).

### `index.ts` - source at render, compute at flush
- **Render** (`context` handler, index.ts:824): pass the persisted boundary as the new trailing arg -
  ```ts
  pruneMessages(messages, indexer, ...existing args..., frontier.get()?.thinkingStripBoundaryTimestamp)
  ```
  which reaches phase 4 as `stripOldThinking(current, thinkingStrip, thinkingBoundaryTimestamp)`.
- **Flush** (`flushPending`, at the `frontierSnapshot` construction, index.ts:489): when `thinkingStrip.enabled`, gather assistant timestamps from the session branch, using the exact unwrap precedent already in-repo (index.ts:527-530):
  ```ts
  const branchMessages = ctx.sessionManager.getBranch()
    .filter((e: any) => e.type === "message" && e.message)
    .map((e: any) => e.message);
  ```
  This must run **regardless of `chainCompression.enabled`** - the existing occurrence is inside the `chainCompression.enabled` branch, so the boundary computation needs its own independent call. Include `options.closingMessage` when it is a not-yet-persisted assistant message (agent-message mode fires `message_end` before pi persists it), take assistant-message timestamps in order, call `computeThinkingBoundary(..., prev = frontier.get()?.thinkingStripBoundaryTimestamp)`, and set `thinkingStripBoundaryTimestamp` on `frontierSnapshot`. It then persists via the existing `frontier.advance(frontierSnapshot)` + `context-prune-frontier` write. When disabled, leave the field carrying `prev` (harmless; phase 4 ignores it).

## Data flow

- **Render (every provider request):** read `frontier.get()?.thinkingStripBoundaryTimestamp` -> `pruneMessages` -> phase 4 strips against that fixed value. Between flushes the value is identical -> byte-identical output -> cached prefix survives the whole tool loop.
- **Flush (`flushPending`, non-empty batches only):** the boundary is computed and stored inside the *same* `frontierSnapshot` transaction that already advances the prune frontier and writes `context-prune-frontier`. This is the [Q2 decision](#boundary-cadence-q2): advance on **every non-empty flush**. The `batches.length === 0` early-return (index.ts:176) means a pure-text turn with no captured batches does **not** advance the boundary (nothing to summarize either).
- **`session_start` / `session_tree`:** the frontier reconstructs from the persisted entry (existing behaviour); the new field rides along. Entries written before this change lack the field -> `undefined` -> live-count fallback until the first new flush.

## Cache economics

The premise "the boundary still moves once per request, so the cache still busts" is true but must be read as *per request*, not *per render* - that distinction is the whole win:

| Design | Thinking-strip cache busts | Thinking retained |
|---|---|---|
| Today (bug: advance every render) | **k per request** (k = tool-loop length, ~5-30 renders) | `keepLastTurns` |
| This spec (advance every non-empty flush) | **1 per request** | `keepLastTurns` (drifts up to `keepLastTurns + turns-since-flush` between flushes) |
| (deferred) flush-gated + turns-stride M | ~1 per M turns of growth | `keepLastTurns + up to M` |

The retained-window "drift up" between flushes is deliberate, not a leak: freezing the boundary is exactly what keeps renders prefix-stable, and the extra thinking is re-read from cache at ~0.1x until the next flush snaps the window back to `keepLastTurns`. Separately, `error-purge` (`purgeErroredArgs`, error-purge.ts:20) derives its cooldown from a **live per-render assistant count** and can rewrite an old assistant's toolCall arguments with no flush involved - an independent live-count history mutator outside this fix's scope, so a literal whole-array-identity claim would be false regardless. That is why the goal/AC are scoped to phase 4's prefix stability, not global byte-identity.

Grounded in the code, the residual 1-per-request bust is **not** always free:

- Phase-1 stub-replace keys off `indexer.isSummarized` (pruner.ts:78), a cumulative set; `rollingWindow` gates only phase-3 chain compression, not per-batch summarization. At a flush the current request's batches are summarized immediately, so at the next render they turn to stubs. The oldest such change sits at ~*start of the just-finished request*.
- **Short request (< `keepLastTurns` turns, the common interactive case):** start-of-request is newer than `tail - keepLastTurns`, so the thinking boundary is the **deeper, dominant** invalidator - not subsumed by summarization. Residual: ~1 deep reprocess per request.
- **Long request (>= `keepLastTurns` turns):** summarization's stub-replace reaches older than the thinking boundary -> thinking-strip is subsumed -> ~0 marginal bust.

Net: flush-gating removes the k-per-request busts (the ~57% figure) unconditionally, and leaves at most one deep reprocess per short request. The steady-state cost of *not* adding a stride knob is that ~1/request reprocess in high-frequency short-request sessions; the cost of adding one would be a config knob plus more retained thinking read from cache every call. Deferred by decision (option 1).

## Boundary semantics

**Stateless recompute, not a running counter.** At each flush the boundary is recomputed from scratch as the `(count - keepLastTurns)`-th assistant timestamp over the raw branch (+ `closingMessage`). There is no "turns since last flush" tally to maintain or reset - the recompute *is* the re-anchor. This matches the current live-count mechanism and how the frontier reconstructs on `session_start`, and it self-corrects for free on session reload. (Relative-advance `prev + (count_now - count_prev)` collapses to `count_now - keepLastTurns` anyway, so the stateful form buys nothing and adds reload/rebuild failure modes.)

**Retained window over time:** `keepLastTurns` **raw-session turns** immediately after a flush; drifts up to `keepLastTurns + (turns since flush)` between flushes (boundary frozen for cache stability); snaps back on the next flush. The count is over the raw branch, so the number of *surviving rendered* turns that keep thinking can be fewer than `keepLastTurns` when phase-3 chain compression has dropped closed chains inside the window - benign, see [Edge cases](#edge-cases).

**Monotonic clamp `max(prev, candidate)`** is a no-op in the normal case (`count` only grows, so `candidate >= prev`). Its sole purpose is the **`keepLastTurns` increased mid-session** case (user cycles the preset up, e.g. 16 -> 32): `count - 32 < count - 16`, so `candidate` would move *backward*, re-adding thinking to already-stripped messages and busting the cache. The clamp forbids that: a larger window applies going forward only. This is the issue's AC restated as a **logical invariant** - thinking is never re-added to a message already stripped - not a numeric one. (`keepLastTurns` *decreased* mid-session moves `candidate` forward and strips more aggressively next flush - allowed, that is what the user asked for.)

## Edge cases

- **Pre-first-flush / no frontier field / old persisted entry:** `undefined` -> live-count fallback (today's behaviour). Cache is not yet valuable at low turn counts.
- **`count <= keepLastTurns`:** `computeThinkingBoundary` returns `prev`; phase 4 fast-paths to the same array reference.
- **Phase-3 middle drops:** the boundary is a timestamp computed over the **raw branch**, while phase 4 runs at render over the post-phase-1-3 survivor array. The timestamp comparison is robust to drops (a dropped message simply is not present to compare). Because chain compression's rolling window (default 3 turns) is *inside* the `keepLastTurns` (16) window, it can drop closed chains that sit newer than the boundary, so immediately after such a flush fewer than `keepLastTurns` surviving turns retain thinking. This is **intended and benign**: it strips *more*, never re-adds, and a dropped turn's thinking is gone with the whole turn anyway. It does **not** "self-correct at the next flush" (the raw branch keeps counting the dropped positions); computing over the raw branch is the deliberate choice because it keeps the boundary stable and decoupled from chain-compression cadence. If "exactly K surviving turns" ever became a hard requirement, the flush would instead compute over the post-phase-1-3 survivor sequence - explicitly out of scope here.
- **Messages without a `timestamp`:** the design assumes every assistant message carries a `timestamp` (true across current fixtures and pi's message shapes). Stated as an explicit assumption; a message lacking one would be treated as older-than-any-boundary by a `< boundary` comparison against `undefined` - acceptable, but noted.
- **Multi-thinking-block message:** `withoutThinkingBlocks` (chain-range-prune.ts:16) filters *all* `type === "thinking"` parts (including signatures), not just the last - locked by an explicit test.
- **`enabled: false`:** phase 4 no-ops as today; the flush skips boundary computation (field left at `prev`).
- **Long tool-only chain, budgets off (default):** no `message_end`, no budget flush -> no flush -> boundary frozen -> thinking accumulates until the chain finally flushes. This is the existing agent-message flush contract (summarization is gated identically); the budget flush is the named backstop when a user opts in. Documented, not fixed here.
- **Session reload:** frontier reconstructs the field from `context-prune-frontier`; stateless recompute resumes at the next flush.

## Testing

`bun test src/` (258 green at baseline) must stay green.

- **Unchanged:** all 12 existing `thinking-strip.test.ts` tests (2-arg calls hit the fallback path). Note the existing suite *already* covers all-or-nothing multi-thinking-block stripping (thinking-strip.test.ts:132) and the `keepLastTurns=0` clamp (thinking-strip.test.ts:99) - do not duplicate them.
- **New - prefix stability across a growing array:** starting from a fixed boundary, render N times where each render **appends** a tail toolCall/toolResult (a real tool loop), and assert the serialized *historical prefix* (everything before the appended tail) is byte-identical across renders. This exercises the actual bug; N reruns over one static array would only re-test idempotence.
- **New - advance only on flush + monotonic:** boundary moves only when recomputed at flush; never regresses, including under a mid-session `keepLastTurns` increase.
- **New - frontier reload round-trip:** persist a frontier carrying `thinkingStripBoundaryTimestamp`, run it through `fromJSON`, assert the field survives (guards the blocker).
- **New - post-chain-drop window:** after a flush whose phase-3 dropped a closed chain inside the K-window, surviving turns older than the boundary have no thinking and the boundary is unchanged from its raw-branch computation.
- **New - `computeThinkingBoundary` unit tests:** `count <= keep` returns `prev`; `count > keep` returns the correct timestamp; `keepLastTurns=0` is clamped to 1 (no out-of-bounds); monotonic clamp holds on `keepLastTurns` increase; `closingMessage` is counted.
- **New - flush integration:** an agent-message flush (`message_end` with captured batches) advances the boundary and strips thinking older than it.

## Acceptance criteria

- [ ] Phase 4 does not mutate any previously-rendered historical message between flushes (shared prefix byte-stable across a growing tool loop).
- [ ] Strip boundary advances on every non-empty flush (covers `message_end` and budget flushes; both route through `flushPending`), not on assistant-turn count per render.
- [ ] Boundary keyed by assistant-message timestamp, computed over the raw branch; robust to phase-3 middle drops (surviving-turn count may dip below K after a chain drop - accepted).
- [ ] Persisted `thinkingStripBoundaryTimestamp` survives session reload (`fromJSON` copies it through).
- [ ] Logical invariant: thinking is never re-added to a message already stripped (monotonic clamp; holds under `keepLastTurns` increase).
- [ ] `keepLastTurns=0` clamped to 1 in `computeThinkingBoundary` (no out-of-bounds boundary).
- [ ] No new config key; `keepLastTurns` presets 4/8/16/32/64 retain their meaning.
- [ ] `PRUNING.md` "Cache impact" corrected.
- [ ] Existing 12 `thinking-strip.test.ts` tests pass unchanged; new tests above added and green.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` "Cache impact" (in "Main-loop Thinking Strip", PRUNING.md:1024-1028). Replace the current paragraph ("Each new assistant turn slides the keep-window by one ... Smaller K is cheaper on both savings and churn (worse only for reasoning continuity).") with, verbatim:

  > pi-ai serializes prompt-cache breakpoints only at `tools`, `system`, and the last conversation message (verified in `@earendil-works/pi-ai` `api/anthropic-messages.js` `convertMessages`) - there is **no in-history breakpoint**. So the strip boundary is flush-gated, not per-render: it is a persisted assistant-message timestamp on the `context-prune-frontier` entry that stays fixed between flushes and advances only on a non-empty flush. Between flushes every render is byte-stable in its historical prefix, so the cache holds through a whole tool loop; the boundary moves at most once per flush (~once per request), turning the old k-busts-per-render into ~1-per-request. That residual bust is not always free: for a request shorter than `keepLastTurns` turns the boundary (tail-K) sits deeper than the current request's just-summarized tool results, so thinking-strip is the dominant invalidator, ~1 deep reprocess per request; for a request longer than `keepLastTurns` turns summarization's stub-replace reaches deeper and subsumes it (~0 marginal). Retained thinking is bounded to `keepLastTurns` raw-session turns, drifting up to `keepLastTurns + turns-since-flush` between flushes (deliberate: the frozen boundary is what buys cache stability). Note `error-purge` still mutates old history off a live per-render count, an independent cache-bust source not addressed here.
- Derived / memory docs invalidated: none - no new customType; the new field rides the existing `context-prune-frontier` entry, whose row in the `AGENTS.md` customType table describes purpose, not schema, so no amendment is required

## Open questions

- **Attribution is inferential.** Phase 4 is the only *per-render* history mutator this fix removes, but flush stub-replace, model switches, and `error-purge`'s live-count cooldown also mutate history; a residual cache bust after this change may come from those (notably `error-purge`, error-purge.ts:20, which is out of scope here). Not blocking - the fix is correct on its own terms; attribution matters only for interpreting post-ship cache telemetry. A follow-up could give `error-purge` the same flush-gated treatment.
