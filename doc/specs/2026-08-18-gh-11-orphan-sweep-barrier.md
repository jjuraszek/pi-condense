# Orphan-sweep barrier semantics (gh-11)

Ticket: [jjuraszek/pi-condense#11](https://github.com/jjuraszek/pi-condense/issues/11).
Partially supersedes `doc/specs/2026-08-12-toolcall-id-collisions.md` - the "C. Orphan sweep" section's barrier rule and its claim that C covers the `stopReason: error|aborted` orphan path (it does not - see Out of scope); its per-turn open-set tracking, no-op invariant, and diagnostics stay authoritative.

## Problem

`sweepOrphanToolResults` (`src/orphan-sweep.ts`) is the last phase of `pruneMessages` and owns the structural post-condition: never hand the provider a `toolResult` whose `tool_use` is gone. Its open-call set is replaced only on `role === "assistant"`; every other non-`toolResult` role is silent pass-through.

Downstream, the barrier definition is different. `convertToLlm` (`pi-coding-agent/dist/core/messages.js`, wired into the agent via `core/sdk.js`; `pi-agent-core/dist/harness/messages.js:57-96` is an equivalent duplicate, cited by the ticket) maps `custom`, `branchSummary`, `compactionSummary`, `bashExecution` to `role: "user"` (dropping `bashExecution{excludeFromContext:true}` and unknown roles). `transformMessages` (`pi-ai/dist/api/transform-messages.js`) flushes `insertSyntheticToolResults()` on both `assistant` and `user` boundaries.

So `assistant(toolCall X) / custom(...) / toolResult(X)` passes the sweep clean, but at the provider boundary pi-ai emits a synthetic `{isError: true, "No result provided"}` for X at the barrier and then still pushes the real result - a duplicate `tool_use_id`. Anthropic 400s permanently on that branch; the shape is unrepairable by pi-ai (it repairs orphan calls, not orphan results). Measured occurrence: pi-cohort spliced a `subagent_control_notice` mid-cycle (upstream cause: jjuraszek/pi-cohort#7); the session survived ~100 assistant turns on kimi-k3 and hard-bricked on the first Claude request. Corpus: 690 mid-cycle barriers across 2170 sessions (687 `user`, 3 `context-prune-summary`), of which 0 are followed by a real `toolResult` for a still-open id - the barrier reset sweeps nothing in today's corpus (the one known bricking instance was hand-repaired out). Rare shape, total failure mode.

This fix is defense-in-depth in pi-condense; it does not gate on, and is not substituted by, pi-cohort#7's steer-delivery fix.

## Decision

Any message that is neither `assistant` nor `toolResult` is a barrier that resets the open-call set:

```ts
if (msg.role !== "assistant" && msg.role !== "toolResult") {
  open = new Set();
  continue;
}
```

placed as the fall-through branch in the existing forward pass of `src/orphan-sweep.ts` (equivalently: an `else` after the `toolResult` branch). Everything else is unchanged: per-turn replacement on `assistant`, single-consume on `toolResult`, swept-id ordering, and the same-array-reference no-op return (`doc/specs/2026-08-04-pruner-noop-serialization.md`).

Consequence, accepted: the interleaved real `toolResult` is swept, and pi-ai injects its repairable synthetic failure for the now-orphaned call. One visible synthetic tool failure instead of a bricked session; structurally the model already saw that synthetic (`transformMessages` emitted it before the barrier). The fix is retroactive - an already-broken branch un-bricks on the next render with no session surgery.

Deliberate over-sweep, not an exact mirror of `convertToLlm`: `bashExecution{excludeFromContext:true}` and unknown roles are dropped by `convertToLlm`, so strictly they need not be barriers - we treat them as barriers anyway. A role allowlist would have to track the open `CustomAgentMessages` interface for zero observed benefit (0 `bashExecution` entries in the corpus). Do not "fix" this into an allowlist.

Rejected alternative: hoisting the barrier message out of the cycle - the hoist index moves as the branch grows (breaks render-is-a-stable-function-of-prefix), reorders a message this extension does not own, and cannot be expressed in the single forward pass.

## Change surface

Minimal by explicit user constraint; tests carry the regression guarantee.

1. `src/orphan-sweep.ts` - the barrier branch above; update the header comment's "Open-call tracking is PER TURN" paragraph to state the barrier reset. (The "immediately preceding assistant turn" phrasing does not appear in this file - it lives in `PRUNING.md:1099,1103`, `src/pruner.ts:51`, and `AGENTS.md:97`, handled in items 4 and 6.)
2. `src/test-support.ts` - `expectNoOrphanToolResults` gets the identical barrier reset. It copies the sweep's own orphan rule, over-sweep included (decision: do NOT delegate to `sweepOrphanToolResults`; that would make sweep tests tautological). One definition of "orphan", two lockstep call sites.
3. `src/orphan-sweep.test.ts` - invert the line-63 test ("non-assistant messages between a call and its result do not close the open set") plus the new tests below. Add a minimal `bashExecution`-role fixture helper; a bare `{role: "bashExecution"}` message is sufficient - the sweep never reads `excludeFromContext`, and plumbing it would imply a distinction the barrier deliberately ignores.
4. `PRUNING.md` (Orphan Sweep section, ~lines 1095-1107 - re-verify at implementation time) - the barrier rule, described as tracking the post-`convertToLlm` `user`/`assistant` flush points of `insertSyntheticToolResults` **plus** the accepted `excludeFromContext`/unknown-role over-sweep (not an exact mirror), and the trade-off: a mid-cycle foreign message now costs one tool output and converts an unrepairable provider shape into pi-ai's repairable one. Fix the "immediately preceding assistant turn" phrasing at lines 1099 and 1103.
5. `doc/specs/2026-08-12-toolcall-id-collisions.md` - supersession banner (per the marking convention): scope `"C. Orphan sweep" section: barrier rule and stopReason error|aborted coverage claim`. Already applied in this worktree; ships with the spec commit - do not add a second banner.
6. Comment-only touch-ups where the old rule is restated: `src/pruner.ts:51` (Phase 4 JSDoc) and `AGENTS.md:97` (layout-table row for `orphan-sweep.ts`).

No behavior changes to `src/pruner.ts` (Phase 4 wiring, diagnostics, and the `orphan-sweep` diagnostic emission are untouched), no signature changes, no new modules.

## Testing

TDD. Exactly one existing test goes red before the change (`orphan-sweep.test.ts:63`, verified by the roaster: patch applied -> 466 pass / 1 fail); new tests are written red-first. Bun `describe`/`test`/`expect` with the file's small message-factory style.

- **AC1** - parametrized over `[custom, user, branchSummary, compactionSummary, bashExecution]` **plus one unknown role** (e.g. `{role: "future-role"}`) so a role-allowlist implementation cannot pass: `assistant(toolCall X) / <role> / toolResult(X)` sweeps X and reports it in `sweptIds`. The line-63 test is inverted to this.
- **AC2** - multi-call turn `assistant(X, Y) / toolResult(X) / custom / toolResult(Y)` sweeps only Y (barrier clears the remainder of the open set; `toolResult` itself is not a barrier - keep the existing consecutive-results control test).
- **AC3** - `assistant(toolCall X) / toolResult(X) / custom` is untouched and returns the **same array reference**.
- **AC4** - pi-condense's own output never trips the barrier, via the existing `pruneWithZeroSweepAssertion` / `expectZeroOrphanSweep` helpers (`src/test-support.ts:31,47`). Shape (a) - a compressed-chain fixture whose range contains a third-party `custom` message - already exists: `chain-range-prune.test.ts:789-793` ("a third-party custom message inside a range survives"), driven through `expectZeroOrphanSweep` at `:862`; it must stay green, no new fixture. Shape (b) - a `context-prune-summary` following a completed cycle sweeps zero - is genuinely missing and is the only new AC4 fixture; extend the nearest suite (`chain-range-prune.test.ts` zero-sweep table or `pruner.test.ts:941-1033`) rather than authoring a fresh harness. Structural reason the invariant holds: summaries are delivered via `deliverAs: "steer"` or at `turn_end`/final-assistant `message_end`, and `applyChainCompressions` inserts its synthetic strictly after a `user`-role `startIndex` and drops every in-range `assistant`/`toolResult` - no partial cycle survives to be split.
- **AC5** - one red-first test that directly exercises the helper's barrier reset: `expectNoOrphanToolResults([assistant(X), custom, toolResult(X)])` must throw (today it passes - the helper still uses the pre-fix rule, and none of its 9 existing call sites across `chain-range-prune.test.ts`, `range-compression.integration.test.ts`, `id-collision.integration.test.ts` contains a mid-cycle foreign message, so "staying green" alone proves nothing). Those 9 call sites additionally stay green.
- **AC6** - `bun test src/` green (baseline 467 pass / 0 fail).

Constraint: do not value-import or execute pi-ai's real `transformMessages` in the suite - it is reachable only via the `./api/*` subpath and nothing else in this repo value-imports pi-ai; wiring it in would let unrelated pi-ai version bumps red this repo's CI. The end-to-end evidence (fixture -> real `applyChainCompressions` -> sweep -> real `convertToLlm` -> real `transformMessages`) is roast-time manual verification, not automated.

## Out of scope

- `transformMessages` skips `stopReason: "error" | "aborted"` assistant messages before recording their tool calls, so their real tool results become provider-side orphans the sweep (before and after this fix) keeps. 0 corpus occurrences; no code. The predecessor spec claimed the sweep covers this path; the supersession banner's scope explicitly includes that claim.
- pi-cohort#7 (upstream steer-delivery fix) - separate repo, separate PR, no code dependency either way.
- `AGENTS.md` ground-truth pointer cites `pi-ai/dist/providers/transform-messages.js`; the actual path is `pi-ai/dist/api/transform-messages.js`. Known one-liner, not part of this ticket.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` (Orphan Sweep section - barrier rule, rationale, over-sweep trade-off)
- Derived / memory docs invalidated: `doc/specs/2026-08-12-toolcall-id-collisions.md` (supersession banner, section C barrier rule only)

## Open questions

None.
