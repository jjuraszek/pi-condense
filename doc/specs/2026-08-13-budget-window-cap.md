# Budget-trigger window ceiling (300k)

Both token-budget flush triggers scale off the host-reported model context window, which makes them unreachable on huge-window models. This spec caps the window the triggers reason about at 300,000 tokens, without adding a setting.

Origin: [jjuraszek/pi-condense#7](https://github.com/jjuraszek/pi-condense/issues/7) - not its title (which asked for a threshold trigger that already shipped), but the reporter's follow-up comment.

## Problem

`src/budget.ts` computes both triggers against `usage.contextWindow`:

- `shouldBudgetFlush` (`src/budget.ts:9-16`): `usage.tokens / usage.contextWindow >= threshold`
- `usageFraction` (`src/budget.ts:18-22`), consumed by `shouldDeltaFlush` (`src/budget.ts:24-38`): the same ratio

`usage.contextWindow` comes from the host's `AgentSession.getContextUsage()`, whose value is `model.contextWindow` - the model's advertised window. On a 1M-window model, therefore:

| setting | 200k model | 1M model |
|---|---|---|
| `autoBudgetThreshold = 0.4` | fires at 80k tokens | fires at 400k tokens |
| `autoBudgetThreshold = 0.9` | fires at 180k tokens | fires at 900k tokens |
| `budgetTurnDelta = 0.1` | fires on +20k in a turn | fires on +100k in a turn |

Two consequences:

1. **The threshold trigger fires far too late, or never.** A session ends long before 900k tokens, so a user who set 0.9 observes "pruning never happens" - exactly what #7's reporter reported: *"using gpt model that have 1 million window when I set 272k window config still not pruning it, but using deepseek flash at 200k is pruning."*
2. **The delta trigger is dead, not merely late.** A single turn practically never grows context by 100k tokens, so on big-window models the re-arm path never fires at all.

This repo already has the receipts for the cost of pruning too late: `doc/specs/2026-08-12-single-chain-observability-trigger-repair.md` documents a real 1M-window session - 256 turns, ~5h, single tool chain, ~195k raw tool-result tokens resident, peak usage 53.7%, `autoBudgetThreshold = 0.8` never crossed. Every one of those 256 turns paid full prompt cost on tool output that pruning exists to remove.

Prior work addressed adjacent gaps and not this one: `doc/specs/2026-05-30-protected-chain-empty-summary-budget.md:257-365` introduced `autoBudgetThreshold`; `doc/specs/2026-06-02-oversized-output-spill.md:220-318` added `budgetTurnDelta` for the *timing* gap (a single oversized result spiking usage between turn boundaries); the #6 spec addressed the *structural* gap (no `agent-message` boundary in a single-chain session). The window-size interpretation mismatch is a third, independent failure mode.

### Non-goals

- No new user-facing setting. `autoBudgetThreshold` and `budgetTurnDelta` remain the only budget knobs; a third knob would have to be explained in terms of the other two.
- No escape hatch to restore uncapped behavior. This is a product decision, not a compatibility argument: above the cap, flushing earlier is the fix, and below it nothing changes.
- No change to what pruning *does* once triggered, to `pruneOn` modes, to chain compression, or to the status widget.
- Not a diagnostic-only fix (e.g. surfacing the reported `contextWindow` on `/pruner status`). That would inform users while leaving the default behavior broken.

## Design

One exported constant and two one-line formula changes in `src/budget.ts` - the only **production-logic** change. Full changed-file list: `src/budget.ts` (logic + docstrings), `src/budget.test.ts` (tests), `src/types.ts` + `src/commands.ts` (docstrings and the live settings description), `README.md`, `doc/configuration.md`, `PRUNING.md` (docs).

```ts
export const MAX_BUDGET_WINDOW = 300_000;
```

**Threshold trigger** - absolute ceiling on the trigger *level*:

```ts
return usage.tokens >= Math.min(MAX_BUDGET_WINDOW, threshold * usage.contextWindow);
```

Reads as: *fire at your percentage of the model's window, or at 300k tokens, whichever comes first.* The threshold keeps its literal meaning; the cap is only a ceiling. (`threshold <= 1` is already enforced, so a `min` against `usage.contextWindow` itself would be redundant and is omitted.)

**Delta trigger** - ceiling moved into the denominator:

```ts
return usage.tokens / Math.min(usage.contextWindow, MAX_BUDGET_WINDOW);
```

The two shapes differ deliberately, and that asymmetry is the one non-obvious thing in this change, so it carries a code comment above `MAX_BUDGET_WINDOW`, verbatim:

```ts
// Ceiling on what the budget triggers treat as the context window. Advertised
// windows reach 1M, which makes any (0,1] fraction unreachable in a real session.
// The two triggers apply it in different shapes on purpose: the threshold is a
// LEVEL, so the cap bounds the level itself (min(CAP, threshold * window)); the
// delta is a GROWTH RATE, where a 300k ceiling could never bind, so the cap
// enters through the denominator instead (delta * min(window, CAP)).
```

The threshold is a *level*, so a ceiling on the level is meaningful. The delta is a *growth rate*, and a 300k ceiling on growth would never bind (no turn grows context by 300k), so the cap has to enter through the denominator. Algebraically `delta * min(W, CAP)` is `min(delta*W, delta*CAP)` - it is still a ceiling, just one proportional to the configured delta. A standalone growth constant (e.g. a hardcoded 30k) was rejected: at `budgetTurnDelta = 0.3` on a 200k model it would fire at +30k where today it fires at +60k, breaking the invariant below, and it would be a second magic number silently required to stay in ratio with the first.

### Why 300,000

The ceiling's only job is to stop the setting from being *unreachable*. Users keep full downward control - on a 1M model, `autoBudgetThreshold = 0.1` still means 100k - so the ceiling does not need to be tight, it needs to clip the pathological tail.

300k buys a clean invariant: **the ceiling never binds on a model advertising 300k or less, at any threshold or delta value** - so no user on a model at or below 300k sees any change. Above the cap, behavior does change: those users now flush earlier, which is the entire point of the fix (a 400k window at `0.9` moves from 360k to 300k; 1M at `0.9` from 900k to 300k). Alternatives considered and rejected:

- **200k** - breaks the invariant: a 256k-window model at `0.9` would clip from 230.4k to 200k, silently changing behavior for a mainstream model.
- **250k** - breaks it marginally (a 272k window at `>= 0.92`).
- **400k** - fixes `0.9` on 1M (900k -> 400k) but leaves `0.4` on 1M unchanged, i.e. no improvement for the common case.

Long-context quality evidence supports a ceiling in this region but is **not** the primary argument: RULER ([arXiv:2404.06654](https://arxiv.org/abs/2404.06654), COLM 2024) found that of 17 models claiming >= 32k, "only half of them can maintain satisfactory performance at the length of 32K"; NoLiMa ([arXiv:2502.05167](https://arxiv.org/abs/2502.05167), ICML 2025) found that at 32k, 11 of 13 models claiming >= 128k fall below 50% of their own short-context baseline (GPT-4o: 99.3% -> 69.7%). Neither covers a 2026 frontier 1M-window model, so neither can justify a specific ceiling on quality grounds. The primary argument is per-turn prompt cost, evidenced by the #6 session above.

### Effect

| model window | setting | today | after |
|---|---|---|---|
| 200k | `threshold 0.4` | 80k | 80k (unchanged) |
| 256k | `threshold 0.9` | 230.4k | 230.4k (unchanged) |
| 272k | `threshold 1.0` | 272k | 272k (unchanged) |
| 1M | `threshold 0.4` | 400k | 300k |
| 1M | `threshold 0.9` | 900k | 300k |
| 200k | `delta 0.1` | +20k | +20k (unchanged) |
| 1M | `delta 0.1` | +100k (never fires) | +30k |

For any model at or below the cap, the change is a no-op; above it, flushes happen earlier by design, and no case flushes *later* than today.

### Contract change: `usageFraction` may exceed 1

`usageFraction`'s docstring currently promises a 0-1 fraction. That promise is retracted: at 600k tokens on a 1M-window model it now returns 2.0. The value is **not** clamped - clamping at 1.0 would make the delta trigger saturate above the cap and stop re-arming, reproducing the exact failure this spec removes.

Both consumers are safe with unbounded values, verified: `shouldDeltaFlush` (`src/budget.ts:24-38`) only takes a difference of two fractions, and `index.ts:950` stores the value as `previousFraction` for the next turn. The status widget does not consume `usageFraction`, so there is no display math to reconcile.

### Edge cases

| case | behavior |
|---|---|
| `contextWindow <= 300k` | `min` never binds; byte-identical to today |
| `usage.tokens == null` (right after host compaction; the host only trusts assistant usage newer than the last compaction) | existing guards return `false` / `null`; unchanged |
| `usage` absent, or `contextWindow <= 0` | existing guards return `false` / `null`; unchanged |
| `threshold` outside `(0, 1]` | rejected by existing guard in `shouldBudgetFlush` and by `src/config.ts:83-89` validation; unchanged |
| fraction above 1.0 | permitted, unclamped; `previousFraction` may hold `> 1` |
| `threshold = 1.0` on a 1M model | fires at 300k, not 1M - intended tail-clipping |
| tiny window (e.g. 8k local model) | `min(300k, 0.4 * 8k) = 3.2k`; unchanged |
| `previousFraction == null` (first turn after load) | delta never fires; unchanged - the threshold trigger covers that turn |

## Testing

Extend `src/budget.test.ts` (bun, existing `describe` / `it` / `expect` style). Tests import `MAX_BUDGET_WINDOW` rather than duplicating the literal, except the one assertion on the constant's own value.

`shouldBudgetFlush`:
- 1M window, `0.4`: fires at 300,000; does not fire at 299,999.
- 1M window, `0.9`: fires at 300,000 (the ceiling, not 900k).
- 200k window, `0.4`: fires at 80,000, not at 79,999 (unchanged behavior).
- 256k window, `0.9`: fires at 230,400, not below (invariant at the boundary that 200k would have broken).
- 300k window, `1.0`: fires at exactly 300,000.

`usageFraction`:
- 1M window, 600k tokens: returns 2.0 (proves no clamp).
- 200k window, 80k tokens: returns 0.4 (unchanged).

`shouldDeltaFlush`:
- 1M window, `0.1`: fires on 100k -> 130k; does not fire on 100k -> 120k.
- 200k window, `0.3`: still requires +60k (unchanged; the rejected standalone-constant design would fail this).

All existing tests in `src/budget.test.ts` must pass unmodified - that is the mechanical proof of the invariant.

Verification: `bun test src/` plus the typecheck command in `AGENTS.md`.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - the single `autoBudgetThreshold` row (`README.md:163`); the settings table has no `budgetTurnDelta` row and this spec does not add one (that knob is documented in `doc/configuration.md`, which the README row links onward to). Replacement text for that row's description: `Fraction (e.g. 0.8) of the context window that force-flushes everything regardless of pruneOn; the trigger point is capped at 300k tokens`. `doc/configuration.md` - the `autoBudgetThreshold` row (`:61`), the `budgetTurnDelta` row (`:64`), and the "Token-budget auto-flush" section (`:77`). `PRUNING.md` - the two trigger sections, "Token-budget auto-flush trigger" (`:817`) and "Budget-delta flush" (`:825`, whose formula is written as `tokens / contextWindow`), **and separately** "Single-chain sessions" (`:968-976`), whose "lower `autoBudgetThreshold`" advice is partly obsoleted by the ceiling
- Derived / memory docs invalidated: none - `AGENTS.md`'s routing table and layout section describe `src/budget.ts` at a granularity this change does not alter

In-code documentation surface (implementation, not doc-impact entries): the `src/budget.ts` docstrings (including `usageFraction`'s retracted 0-1 promise and the level-vs-growth asymmetry comment), `src/types.ts:385-407` setting docstrings, and `src/commands.ts:236-240` `autoBudgetThresholdDescription`, which renders live in `/pruner settings`.

Wording across all sites states the two contracts separately and exactly as coded - there is no single unified "effective window" phrase, because the two triggers do not share one denominator:

- threshold: fires when context reaches `min(300k, threshold * model window)` tokens - *your percentage of the model's window, or 300k tokens, whichever comes first*
- delta: fires when a single turn's growth reaches `delta * min(model window, 300k)` tokens - i.e. the growth fraction is measured against a window capped at 300k

Writing the threshold as "`threshold` of an effective window of `min(window, 300k)`" would be wrong: on a 1M model at `0.4` that reads as 120k, where the implementation fires at 300k.

## Open questions

None blocking. Recorded for completeness, all deliberately not resolved by this spec:

- Where the reporter's "272k window config" actually lived (host `models.json` override, a gateway, or misremembering) is unknown; the reporter never replied and #7 is closed. The design does not depend on the answer - a host-side `contextWindow` override does reach `getContextUsage()`, and the ceiling works whether or not one is configured.
- Whether to reply on the closed #7 or open a fresh issue per this repo's ticket convention is a process choice, made at ship time, not a design input.
