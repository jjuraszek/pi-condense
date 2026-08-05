# Remove the thinking strip

Supersedes: [doc/specs/2026-08-04-thinking-strip-flush-gated.md](./2026-08-04-thinking-strip-flush-gated.md) - fully.

## Context

`thinkingStrip` removes `thinking` blocks from older assistant turns at render time, keeping them on the last `keepLastTurns` (default 16). It has shipped since v0.13.0; v2.4.3 made its boundary flush-gated to stop a per-render cache break.

The feature was designed against an assumed API model: that thinking blocks we send are thinking blocks the model reads and we are billed for, so removing old ones saves tokens. That model is wrong. This spec records the measurements that disprove it and removes the feature.

## Problem

Anthropic's actual handling of `thinking` blocks, verified against the live API (`count_tokens` and real billed usage agree to the token):

| regime | billed input tokens | probe |
|---|---|---|
| thinking in a **closed** cycle (a user text turn has since occurred) | 0 | `withThinking=566 stripped=566 delta=0` |
| thinking in an **open** cycle, contiguous from the cycle's first assistant turn | billed in full | `first 4` bills 4 blocks, `ALL 0-7` bills 8 |
| thinking in an open cycle **after any gap** | 0 | `last 4 (4-7)` bills 0, `middle (3-4)` bills 0 |

Three consequences, each independently fatal to the feature:

**1. It strips what is already free.** Closed-cycle thinking costs zero input tokens and is dropped from the context window before the model attends to it. Stripping it saves nothing and changes nothing the model sees.

**2. It delivers no thinking to the model, and pays for the privilege.** In an open cycle, retention is a *prefix* property: only the unbroken run starting at the cycle's first assistant turn survives. `keepLastTurns` keeps the *last* K, so the moment it fires it punches a gap at the front and Anthropic discards every block after it - including the K it just preserved. The model receives zero thinking either way, and the transition from no-gap to gap is a full cache invalidation.

Measured in a controlled A/B (24 sequential file reads, isolated `PI_CODING_AGENT_DIR`, identical prompts):

```
BASE     (bare pi, no extension)                cacheWrite= 89449  cost=$0.6495
NOSTRIP  (pi-condense, thinkingStrip disabled)  cacheWrite= 87781  cost=$0.6430
COND     (pi-condense, defaults)                cacheWrite=148222  cost=$0.8531   +33%
```

`COND`'s only non-warmup break is turn 17 - the first turn past `keepLastTurns=16` - which rewrote 63113 tokens at 0% cache reuse. `NOSTRIP` has no extra breaks over `BASE`.

Direct API confirmation that gap *creation* is the invalidating event, and that moving an existing gap is free:

```
req2  a1=think          (no gap)   write=5004  read=0        prime
req3  a1=strip a2=think (GAP)      write=3485  read=0        full miss
req3  a1+a2=think       (no gap)   write=1633  read=5004     hit
```

**3. The economics can never work.** Retained thinking bills at cache-read rates ($0.30/Mtok); removing it costs a cache write ($3.75/Mtok). The 12.5x asymmetry means a strip only pays back if the same cycle continues for roughly another 130 turns. Across 58 gridstrong sessions (1233 open cycles):

| | |
|---|---|
| median cycle length | 3 assistant turns |
| cycles > 16 turns (strip fires) | 253 (20.5%) |
| cycles > ~130 turns (strip breaks even) | **2 (0.2%)** |
| estimated strip cost across the archive | ~$95 of $2564 total spend |

The feature is net-negative in roughly 250 of its 253 firings.

**4. It is redundant with chain compression.** `applyChainCompressions` in `src/chain-range-prune.ts` emits the synthetic chain block as `role: "user"` with a `type: "text"` block (line 34 at time of writing). Anthropic reads that as a genuine user turn, which closes the cycle and discards all prior thinking - at zero cache cost, because the range drop was already rewriting that region. Stub replacement does not do this: `src/pruner.ts:109` preserves `role: "toolResult"`, so the cycle stays open.

```
full toolResult,    a1+a2 think              billedThinking=3152
STUBBED toolResult (role kept), a1+a2 think  billedThinking=3152   no effect
chain-drop user TEXT inserted before a2      billedThinking=0      cycle closed
```

Chain compression is enabled by default and fires several times per session, against the strip's ~4.3. It already performs the strip's intended job, for free, at a semantic boundary rather than an arbitrary turn count.

## Decision

Remove `thinkingStrip` entirely. No replacement mechanism, no replacement config key.

The resulting behavior is the union of two things that are already correct and already free: Anthropic drops closed-cycle thinking server-side, and chain compression closes cycles as a structural side effect of range dropping. What remains resident is open-cycle thinking since the last chain drop, which is the reasoning the model is actively using and which bills at cache-read rates.

### Alternatives considered and rejected

**Lower or raise `keepLastTurns`.** The knob has two reachable states, not a range. Below the cycle length there is a gap and the model sees no thinking; above it there is no gap and the model sees all of it. Every value from 1 to 15 produces identical behavior in a 20-turn cycle. Raising to 32 moves the cliff later and makes more cycles pay full freight before reaching it.

**Keep the first N turns instead of the last N.** Matches the API's prefix semantics, but inverts relevance: the model would retain reasoning about work already completed and lose the reasoning that produced the tool call whose result just arrived. Dominated by keep-all (which includes those same blocks plus the relevant ones) and by keep-none (which is free).

**Keep only the most recent turn (keep-last-1).** Forces a no-gap-to-gap transition at the third request of *every* cycle, raising the invalidation count from ~4.3/session to ~21/session. Roughly 4x worse than the bug it would replace.

**Gate the boundary to the stub frontier** (strip thinking exactly when its tool results are stubbed - the original proposal this worktree was opened for). Genuinely free: the invalidation is already happening at that position. But worth $4.59 across all 58 sessions (15.3M resident tokens at cache-read rates), or $0.08/session against a $44/session average. It also cannot express the intent cleanly - punching the gap drops *all* open-cycle thinking, including reasoning about tool results that are still fully present in context. Rejected on the repo's own bar: the coupling from `thinking-strip` to `frontier` is not worth 0.2%.

### Accepted consequence

Thinking blocks that reason about pruned tool outputs are retained rather than stripped. This is bounded and acceptable:

- Before the last chain drop: thinking is dropped server-side and never reaches the model. No exposure.
- After it: the referenced outputs are mostly unpruned anyway (`recoveryGraceTurns` protects the last 3 turns), and pruned ones are replaced by a stub plus its summary, recoverable via `context_tree_query`.
- The extension already retains assistant *text* and *tool calls* that reference pruned outputs, unconditionally and always live in the window. Singling out thinking would be inconsistent.

Residual risk is summarizer fidelity - a summary that drops a detail the retained thinking cites. That is a summarizer concern, not a thinking-retention one, and is out of scope here.

With the strip gone, `chainCompression.enabled: false` becomes the only configuration that carries open-cycle thinking indefinitely. Measured worst case across 1233 cycles is 30750 tokens (126 turns); median 388, p99 8968; zero cycles above 50k. Documented, not guarded.

## Scope

Delete:

| target | note |
|---|---|
| `src/thinking-strip.ts` | whole module (`stripOldThinking`, `computeThinkingBoundary`) |
| `src/pruner.ts` phase 4 | and the `thinkingStrip` + `thinkingBoundaryTimestamp` params of `pruneMessages` |
| `src/types.ts` | `ThinkingStripConfig`, `ContextPruneConfig.thinkingStrip`, `DEFAULT_CONFIG.thinkingStrip`, `PruneFrontier.thinkingStripBoundaryTimestamp`, and the `KEEP_LAST_TURNS_PRESETS` export (line 171) - it has no other consumer |
| `index.ts` | the `computeThinkingBoundary` import (line 39); boundary computation in `flushPending` (lines 507-511); its assignment to `frontierSnapshot`; the argument at the `pruneMessages` call site. Also narrow the `branchMessages` unwrap conditional (line 495) from `thinkingStrip.enabled \|\| chainCompression.enabled` to `chainCompression.enabled` alone |
| `src/frontier.ts` | `thinkingStripBoundaryTimestamp` in `fromJSON` |
| `src/commands.ts` | the `KEEP_LAST_TURNS_PRESETS` import (line 19), the `thinkingStripEnabled` toggle and `thinkingStripKeepLastTurns` selector (its preset usage at lines 661-664), and both `onChange` handlers |
| tests | delete `src/thinking-strip.test.ts`; strip phase-4 cases from `src/pruner.test.ts` and boundary cases from `src/frontier.test.ts`; update the positional `pruneMessages` call sites in `src/range-compression.integration.test.ts` and `src/oversized-spill.integration.test.ts` for the shortened signature |

Backward compatibility, both directions of an in-flight session:

- A `contextPrune.thinkingStrip` block left in a user's `settings.json` is inert but **persists**. `normalize()` in `src/config.ts` builds `{ ...DEFAULT_CONFIG, ...existing }` and then re-spreads it, so unrecognized keys are neither filtered nor rejected: the block survives `loadConfig()` untouched and is re-serialized verbatim by the next `saveConfig()`. It never throws or warns. No code change and no deprecation notice - the key simply stops being read, and stays in the file until a user removes it by hand.
- A persisted `context-prune-frontier` entry carrying `thinkingStripBoundaryTimestamp` is ignored on `session_start`. The field is optional and read-only at that site.

## Testing

- Delete `src/thinking-strip.test.ts`. Remove the phase-4 assertions from `src/pruner.test.ts` and the boundary-specific cases from `src/frontier.test.ts`. Update the positional `pruneMessages` calls in `src/range-compression.integration.test.ts` and `src/oversized-spill.integration.test.ts` to the shortened signature.
- **New** (additive) test: `pruneMessages` leaves `thinking` blocks untouched on assistant messages. Pin `stripFinalAssistantThinking: false` in this fixture - with the default `true`, `applyChainCompressions` legitimately strips thinking from a compressed chain's kept final assistant, so an unqualified "untouched everywhere" assertion would contradict that mechanism.
- Leave the existing `"strips thinking blocks from final assistant when stripFinalAssistantThinking is true"` case (`src/pruner.test.ts:182`) in place - that mechanism is out of scope and must keep working.
- Assert a session resumed from a frontier entry containing `thinkingStripBoundaryTimestamp` loads without error and strips nothing.
- Assert a `settings.json` containing `contextPrune.thinkingStrip` loads without error and round-trips the key unchanged.
- Full suite green: baseline on this branch is `274 pass, 0 fail, 23 files` (`bun test src/`).
- Typecheck per AGENTS.md before committing.
- Smoke test against an isolated `$PI_CODING_AGENT_DIR`: `DEFAULT_CONFIG.enabled` is `false`, so the settings file must set `contextPrune.enabled: true` and the prompt must force real tool calls and a flush. Assert **at least one** `context-prune-frontier` entry was written before asserting that none of them carries `thinkingStripBoundaryTimestamp` - otherwise the check passes vacuously on a session that never flushed.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` (delete the "Main-loop thinking strip" section and its cache-impact discussion; add a short note that chain drops close the assistant cycle server-side and that closed-cycle thinking is free, so no strip is needed); `doc/configuration.md` (delete the `thinkingStrip` block from the settings JSON example at line 39 and both `thinkingStrip.*` rows from the settings table at lines 76-77 - this is the file README designates as the full settings reference); `CHANGELOG.md` (breaking: config key removed). `README.md` needs no edit - it contains no `thinking` references.
- Derived / memory docs invalidated: `AGENTS.md` - the Project Layout block lists `src/thinking-strip.ts`, and the `src/pruner.ts` line describes the phase composition as `stub-replace -> error-purge -> chain-range-prune -> thinking-strip`; both need updating in the same commit

## Out of scope

- **`chainCompression.stripFinalAssistantThinking`** - a separate mechanism, not measured here, plausibly carrying the same defect. Belongs to chain compression; decide separately rather than removing it as a ride-along.
- **Chain compression's own cache behavior.** A 6-prompt A/B showed chain compression costing +4.5% ($0.4784 -> $0.5000) with 2 full invalidations from 3 chain drops, but the fixture peaked at 20k tokens where the archive median is 131k - the regime where compression is supposed to pay. Not a verdict; needs a large-fixture A/B before any conclusion.
- **The unattributed remainder of archive rewrite spend.** The strip explains ~$95 of ~$1997. A prompt-delta proxy suggested far more breaks than the controlled runs reproduce; the proxy is unreliable and the remainder is unexplained.
- **Summarizer fidelity** for details cited by retained thinking.

## Measurement caveats

- The 58-session gridstrong archive predates v2.4.3 for 55 of 58 sessions, so it measures the per-render boundary, not the flush-gated one. The cycle-length and thinking-volume statistics are unaffected by this (they are properties of the transcript, not of the strip); the ~$95 cost figure is specific to the pre-2.4.3 path and is an upper bound for the current one.
- Cost figures use Sonnet 4.5 pricing: $3/Mtok input, $15/Mtok output, $3.75/Mtok cache write (5m), $0.30/Mtok cache read.
- The controlled A/B peaks at 89k tokens; archive median peak is 224k. Conclusions about the strip hold regardless of scale (the mechanism is positional, not size-dependent), but absolute costs do not extrapolate linearly.

## Open questions

- `chainCompression.stripFinalAssistantThinking` defaults to `true` and is untested against the prefix-retention rule. Track separately.
