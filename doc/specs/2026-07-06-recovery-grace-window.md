# Recovery grace window: render-time bounded verbatim for `context_tree_query` output

## Problem

The pruner re-prunes its own recovery tool's output, forcing a retrieve -> re-stub -> re-query loop the agent experiences as "fighting the pruner."

Observed failure (real session `019f383f-...`, repo `gridstrong`, 2026-07-06): a `collect.py` standup dump (7784 chars, ref `t1`) was summarized to a 742-char stub at the first turn boundary. A later user question ("why the Jacek prefix?") needed the raw output, so the agent issued `context_tree_query(["t1"])` and recovered the full text into context. At the **next** turn boundary the pruner captured and re-stubbed that recovered output - the batch index at that turn lists `toolNames: ["context_tree_query", "context_tree_query", "bash", "bash"]`, i.e. the extension summarized its own recovery call. The agent had to re-query, and the cycle repeated. The agent's own words in that session: *"I've been fighting the context pruner (my `context_tree_query` calls kept coming back summarized)."*

Root cause: `context_tree_query` output is an ordinary tool result. It has `toolName: "context_tree_query"`, is `> minBatchChars` (1000), and is not in `protectedTools` (default `[]`), so it is captured, indexed, and stubbed at render like any other output. Content-hash dedup does not help: two identical `context_tree_query(["t1"])` results dedup to *each other*, but dedup runs at prune time, not call time, so it never prevents the agent from issuing the re-query - it only avoids double-summarizing.

`protectedTools` cannot fix this cleanly. Adding `context_tree_query` there means **permanent** verbatim retention (the record is never stubbed, ever), so a session that recovers many large originals slowly regrows context with no ceiling - defeating the pruner's purpose. The exemption needs a **lifetime bound**.

### Empirical grounding

Mined from the local pi session corpus (`~/.pi/agent.anthropic/sessions/**`, 4194 sessions, 3879 with pi-condense active, 518 actually issuing `context_tree_query`, 1415 total ctq calls):

Re-query gap - user-turn-groups (UTG) between successive `context_tree_query` calls for the **same** ref within a session:

| metric | value |
|---|---|
| sessions with >=1 re-query | 54 (10.4% of ctq sessions) |
| total re-query events | 99 |
| gap median | 2 UTG |
| gap <= 1 / <= 2 / <= 3 / <= 5 | 44% / 71% / 81% / 86% |
| gap == 0 (same user-turn) | 0 |

Two load-bearing facts:

1. **Every re-query crosses a user turn** (gap == 0 is literally zero across 99 events). The thrash is an across-user-turn phenomenon, never within a single user-turn-group. So user-turn-groups is the correct unit, and a window of **3 UTG covers 81%** of re-queries (the gap<=3 mass; diminishing returns past 3).

2. **A user-turn-group window must NOT be applied globally.** Session length is median **1** UTG, and **77% of pi-condense sessions have <= 3 UTG**. Those single-UTG sessions are long autonomous agent runs - exactly where tool-output accumulation is worst and pruning matters most. A general "keep last K UTG of all tool outputs verbatim" window would keep the entire session verbatim in 77% of sessions and disable pruning where it is needed most. Therefore the grace window is scoped to `context_tree_query` output only, not all outputs.

## Decision

Add a **bounded-lifetime verbatim exemption** for `context_tree_query` output, enforced at **render/prune time**, not at capture time.

Recovery output is captured, indexed, spilled, deduped, and frontier-tracked exactly like any other output - no capture-path change. What changes is the two points where a summarized output is actually *dropped from what the model sees*:

- **Phase 1 stub-replace** (`src/pruner.ts`) renders the recovery output **verbatim** (skips the stub) while it is within grace, and renders the normal stub once it ages out.
- **Chain compression eligibility** (`src/chain-compressor.ts`) **defers** compressing any chain whose span still contains an in-grace recovery output, so Phase 3 cannot drop the span out from under Phase 1.

Both consult one predicate: a recovery output is *in grace* while `nowUTG - recoveryUTG <= recoveryGraceTurns`.

- **K is configurable**, default **3** (empirical: covers 81% of re-queries at gap<=3).
- **Unit is user-turn-groups.**
- **Clock is fixed from recovery.** Recovered in UTG N -> verbatim through UTG N+K -> stub from UTG N+K+1. No reset-on-reference (the model reading a block is not observable) and no reset-on-re-query (per the dedup analysis, a re-query can only fire *after* the output aged out, and the fresh record starts its own clock, so a reset path would be dead code).

### Why render-time, not capture-time exclusion

An earlier draft excluded recovery output from *capture*. The spec council (4 members + chair) killed it against source: `trimBatchToPendingRange` (`index.ts:113`) drops any batch whose `turnIndex < frontier`. A capture-excluded recovery call keeps its old `turnIndex`; by the time it "ages out," the frontier has advanced past it, so the batch returns `null` and is dropped **forever** - i.e. the lifetime bound silently degrades to permanent verbatim, the exact unbounded-regrowth failure `protectedTools` was rejected for. Capture-time exclusion also bypassed the live `turn_end` path (`index.ts:696-724`, which spills + marks summarized before any branch scan) and the chain-compression drop path.

Render-time enforcement sidesteps all three: because indexing stays uniform, the frontier, dedup, spill, and live path all behave exactly as today. The recovery output always has a `t<N>` ref and a record; the only decision deferred to render is *stub vs verbatim*, and that decision is recomputed every turn from live state. `src/pruner.ts:74-81` **already** performs a render-time verbatim skip for `isProtected` records - this feature extends that exact seam with a time-bounded predicate.

### Computing UTG at render (positional, no stored field)

`pruneMessages` receives the full branch message array every turn. UTG is derived positionally, requiring **no** new field on `ToolCallRecord` and **no** `addBatch` change:

- `nowUTG` = total count of `role === "user"` messages in the array.
- `recoveryUTG` for a given toolResult = count of `role === "user"` messages at or before its position (a prefix count over the same array).
- age (in UTG) = `nowUTG - recoveryUTG`; in grace while `age <= recoveryGraceTurns`.

This works uniformly for branch-scan-captured, live-`turn_end`-captured, and spilled recovery outputs, because it reads the rendered message stream rather than capture metadata. (The existing `userTurnGroup` counter in `src/batch-capture.ts` is a capture-path concept used by `groupBatchesByMode`; it is deliberately not reused here.)

### Spilled recovery output

No special handling. A live-captured oversized recovery output is spilled to a sidecar and marked summarized (unchanged). At render, the raw toolResult is still present in the branch, so the grace path returns it verbatim and the sidecar simply goes unused until the output ages out, at which point Phase 1 renders the existing spill-pointer stub. Consequence, stated deliberately: an oversized recovery stays fully in context for up to K UTG (the agent recovered it because it needs it); this is bounded and intended.

### What this does NOT change

- Capture, indexing, frontier trim, dedup, spill, the live `turn_end` path - all unchanged.
- All other tool outputs (`bash`, `read`, etc.) stub at render exactly as today. No global grace window.
- `protectedTools`, `protectedPaths`, `minBatchChars`, `pruneOn`, `batchingMode`, `thinkingStrip`, error-purge - unchanged.
- A recovery call also present in `protectedTools` stays permanently verbatim: the existing `isProtected` skip (`pruner.ts:78`) runs first, so permanent protection wins over the bounded grace.

### Deliberate trade-off

A recovery output still referenced *after* K UTG is stubbed and may be re-queried (the ~19% tail of the gap distribution). This is the accepted cost of bounding regrowth; permanent retention (rejected) would eliminate the tail but reintroduce unbounded growth.

## Config

New field on `ContextPruneConfig` (`src/types.ts`), added to `DEFAULT_CONFIG`:

| Aspect | Decision |
|---|---|
| Field | `recoveryGraceTurns: number` |
| Default | `3` (covers gap<=3 = 81% of re-queries) |
| Unit | user-turn-groups |
| Semantics | recovery output rendered verbatim while `nowUTG - recoveryUTG <= recoveryGraceTurns` |
| Disable | `0` = no grace; recovery output stubs immediately like today (opt-out to pre-feature behavior) |
| Placement | top-level scalar on `ContextPruneConfig`, sibling to `minBatchChars` (it governs the Phase-1 render path and chain eligibility, not chain compression internals) |
| Consumed in | `src/pruner.ts` (Phase 1 render) and `src/chain-compressor.ts` (eligibility deferral) - **not** the capture path |

Normalization matches the sibling-scalar convention in `normalize()` (align with how `minBatchChars` / `rollingWindow` handle bad input): an explicit `0` is a valid kill switch and is preserved; values `< 0`, `NaN`, or non-finite fall back to the default `3`; a positive non-integer is floored.

### Tool-name constant

`src/query-tool.ts:9` registers the name as the string literal `"context_tree_query"`. Introduce a shared exported constant (`QUERY_TOOL_NAME` in `src/types.ts`, beside the `CUSTOM_TYPE_*` constants) and reference it from `query-tool.ts`, `src/pruner.ts`, and `src/chain-compressor.ts`, so the registration and the two grace checks cannot drift.

### UI surface

Mirror the existing scalar knobs (`minBatchChars`, `rollingWindow`): add a `RECOVERY_GRACE_PRESETS` array in `src/types.ts`, a `recovery-grace` subcommand in `src/commands.ts` (show-or-set with a description string), and a row in the `/pruner settings` interactive overlay. Settings-parity requirement, not a new UX pattern - a user who can tune `minBatchChars` must be able to tune `recoveryGraceTurns` the same way.

## Implementation

### 1. `src/pruner.ts` - Phase 1 grace render

`pruneMessages` gains the `recoveryGraceTurns` value (threaded from config alongside the existing `protection` argument). Before the map, compute a prefix count of user messages; `nowUTG` is the total. Inside the existing summarized-toolResult branch, after the `isProtected` skip (`pruner.ts:78`) and before building the stub:

```
if (recoveryGraceTurns > 0 && record?.toolName === QUERY_TOOL_NAME) {
  const age = nowUTG - userTurnsAtOrBefore[i];
  if (age <= recoveryGraceTurns) return msg;   // verbatim; raw toolResult already in branch
}
```

`msg` is returned unchanged, so an in-grace recovery output (spilled or not) stays verbatim. The `.map` index `i` keys into the prefix array. Error-result recovery calls (e.g. empty-arg `ctq({})`) are trivially small, so grace on them is a no-op; no special-casing.

### 2. `src/chain-compressor.ts` - eligibility deferral

`compressEligible` selects closed chains beyond the rolling window and drops all `middleToolCallIds` (`chain-compressor.ts:92,118`). Add a guard: a chain is **not** eligible while its span contains a `context_tree_query` toolCallId whose recovery is within grace. The compressor runs over the branch (in `flushPending` and `/pruner compact`) and can compute UTG the same positional way. Once the recovery ages out, the chain becomes eligible normally. This keeps the raw span verbatim during grace, consistent with Phase 1, and prevents the deterministic `/pruner compact` drop the council flagged.

### 3. Config plumbing

`recoveryGraceTurns` flows from `ContextPruneConfig` to the `pruneMessages` call site (`index.ts`, the `context` handler) and to the chain-compressor call sites, beside the values already passed there. No new event wiring, no new custom session-entry type, no summarizer change, no `addBatch`/`ToolCallRecord` change.

## Testing

Unit tests, matching existing `src/` test style.

`src/pruner.ts` (Phase 1 render):
- Recovery output at `nowUTG` (age 0) -> returned verbatim.
- Recovery output aged exactly `K` UTG -> verbatim (`<= K`).
- Recovery output aged `K+1` UTG -> stubbed.
- `recoveryGraceTurns: 0` -> recovery output stubbed immediately at age 0 (pre-feature behavior).
- Non-`context_tree_query` output at age 0 -> stubbed (no global window).
- Spilled recovery output in grace -> verbatim (raw returned, sidecar stub not used); same output past grace -> spill-pointer stub.
- Recovery call also in `protectedTools` -> verbatim at any age (permanent protection precedence).
- Multi-ref / repeated recovery of the same ref -> each toolResult judged by its own position.

`src/chain-compressor.ts` (eligibility):
- Chain whose span holds an in-grace recovery id -> deferred (not compressed).
- Same chain after the recovery ages out -> eligible and compressed normally.
- Chain with no recovery id -> unaffected.

`normalize()`:
- `0` preserved (kill switch); `-1` / `NaN` -> default `3`; `2.7` -> floored to `2`; unset -> default `3`.

Manual smoke-test (concrete repro, no private-session dependency): in an isolated `$PI_CODING_AGENT_DIR`, run a tool producing >1KB output, let it stub, then in a later user turn `context_tree_query` its ref; within K UTG the recovered output must stay verbatim across turn boundaries (inspect the rendered context / session JSONL), and past K UTG it must return to a stub.

## Out of scope

- **Empty-arg `context_tree_query({})` calls.** The corpus shows 475 (33.6% of all ctq calls) issued with no `toolCallIds` - the leaky "first call" that v2.0.1 tried to design out via the tool description. Separate defect (tool-call hygiene, not render policy); deferred to its own ticket.
- A general grace window over all tool outputs (rejected on the 77%-single-UTG data).
- Any change to the summarizer, dedup, spill, frontier, or the capture path.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (config + `/pruner` reference gains `recoveryGraceTurns` - tunable parameter); `PRUNING.md` (algorithm section notes the render-time bounded recovery exemption at Phase 1 + chain-eligibility deferral - non-obvious rationale, incl. why render-time over capture-time); `CHANGELOG.md` - deferred: release
- Derived / memory docs invalidated: none
