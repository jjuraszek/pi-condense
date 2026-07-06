# Summarizer outage fallback

## Context

pi-condense summarizes completed tool-call batches with an LLM (`src/summarizer.ts`,
`runSummarization`). Users commonly point `summarizerModel` at a cheap model (e.g.
`anthropic/claude-haiku-*`) distinct from the session's main model. Provider incidents are
routinely **per-model**: Anthropic's status page regularly shows one model (Haiku) degraded
while Sonnet/Opus stay green.

Today, when the configured summarizer model fails at runtime, `runSummarization` catches the
error, fires `ctx.ui.notify(..., "error")`, and returns `null`. `index.ts` `flushPending`
restores the batch to `pendingBatches` and retries it **on the next flush against the same
dead model**. During a multi-hour single-model outage, pruning stalls for the whole outage
even though the session's main model (`ctx.model`) is healthy and already authenticated
in-session. No data is lost (raw outputs stay in context), but context grows unbounded until
the outage ends.

## Problem

The retry loop re-hits the one model that is down. There is no path that routes summarization
to a different, healthy model during a per-model outage. The result is stalled pruning and
unbounded context growth for the outage duration, despite a usable main model being available.

## Idea

Add a **sticky, in-memory fallback** to the session's main model (`ctx.model`) that engages
only on **transient** (outage-shaped) failures of the configured summarizer model, and returns
to the primary model automatically when it recovers.

Non-goals (explicitly out of scope):

- No new config knob. The fallback target is always `ctx.model`; the 10-minute re-probe
  cooldown is an internal constant. A pin-a-specific-fallback-model config is YAGNI until
  requested.
- No fallback on **auth** failures (bad/missing key is a config problem; `ctx.model` may use
  different auth, so switching would mask a real misconfig).
- No fallback on **truncated/empty** results (`!isUsableSummary`); a one-off bad generation is
  not an outage and must not flip the whole session onto the main model.
- No persistence. Fallback state is a live signal (like the `cost:external` channel), never
  written as a `context-prune-*` session entry.
- Aborts (`signal.aborted`) remain re-thrown, exactly as today.

### Architecture

New module `src/summarizer-fallback.ts` exports a session-scoped `FallbackController`
(class). `index.ts` constructs one instance in the module scope of the extension and calls
`controller.reset()` from the `session_start` handler (matching how `indexer` / `statsAccum`
are reconstructed there), so each session starts with `inFallback=false`. State it holds:

- `inFallback: boolean`
- `lastProbeAt: number` (epoch ms)
- an injected `now(): number` clock (defaults to `Date.now`) for deterministic tests

Method surface (the wiring tests exercise these; a plain field holder cannot implement the
concurrency/dedup behavior below):

- `reset(): void` - clears `inFallback`, `lastProbeAt`; called from `session_start`.
- `pickTarget(primary, ctx, isProbe): Model` - returns `primary` when `!inFallback || isProbe`,
  else `ctx.model`.
- `claimProbe(batchIndex): boolean` - returns `true` for exactly the elected probe batch of a
  flush when `inFallback && now - lastProbeAt >= COOLDOWN_MS`; advances `lastProbeAt` on claim
  so no sibling batch in the same flush also probes. Idempotent per flush.
- `recordOutcome({ target, outcome, wasProbe }): void` - the single transition point;
  `outcome` is one of `success | transient | auth | unusable | abort`. Applies the matrix
  below and fires at most one notify per transition (gated on the `inFallback` flag flip, so N
  concurrent batches produce one warning, not N).
- `notifier` - the controller is constructed with a `notify` callback (bound to `ctx.ui.notify`)
  so transitions can message without importing `ctx`.

Controller plumbing must reach **every** summarization call site, not just the parallel
fan-out. Enumerated call sites (verified in `index.ts` / `src/summarizer.ts`):

1. `summarizeBatches` (parallel fan-out) - controller passed via `SummarizeBatchesOptions`.
2. The sequential progress path in `flushPending` (the `options.onProgress` branch, ~lines
   291-311) calls `summarizeBatch` per batch directly - controller passed via
   `SummarizeBatchOptions`.
3. Range/chain fusion: `makeFuseRange` calls `summarizeRange(text, config, ctx, {})` and the
   `/pruner compact` path via `chain-compressor` - both must pass the controller through
   `summarizeRange`'s options.

`isProbe` is a new field on `SummarizeBatchOptions`, set only by the caller that elected the
probe (see Probe / recovery). All three paths funnel into `runSummarization`, which calls
`pickTarget` -> runs -> `recordOutcome`.

The controller is **inert** when no distinct fallback exists. `Model.provider` is a plain
string in `@earendil-works/pi-ai` (`Provider = KnownProvider | string`), not an object, so
"distinct fallback exists" is evaluated per call as:

```
ctx.model != null  &&  ( primary.provider !== ctx.model.provider || primary.id !== ctx.model.id )
```

where `primary = resolveModel(config, ctx)`. When they match (e.g. `summarizerModel:"default"`)
or `ctx.model` is unavailable, all controller logic is skipped and behavior is byte-for-byte
today's.

### Failure classification

A caught summarizer failure carries no structured status code: `runSummarization` either
throws `new Error(response.errorMessage ?? ...)` on `stopReason === "error"` or catches a raw
stream throw as `err.message` (`src/summarizer.ts` ~lines 160, 175). There is no reliable
5xx-vs-4xx signal to inspect, so a precise `isTransientError` classifier is **not buildable**
without brittle message string-matching, which this spec rejects.

Classification is therefore **coarse**, keyed off the existing control flow rather than error
introspection:

- `abort` - `options.signal.aborted` (re-thrown today; unchanged, never trips the controller).
- `auth` - the **pre-flight** `getApiKeyAndHeaders` failure branch (`src/summarizer.ts`
  ~line 107) returns before any stream call. This is the common bad/missing-key case; it does
  **not** reach the fallback path, so the "don't mask auth misconfig" non-goal holds for it.
- `unusable` - `!isUsableSummary` (empty or `stopReason === "length"`); returns `null` today,
  never trips the controller.
- `transient` - **everything else** that reaches the catch (stream throw or
  `stopReason === "error"`). This is the outage bucket that engages fallback.

**Known bounded gap (accepted):** a key that passes pre-flight but is rejected by the provider
mid-stream surfaces as a generic throw and is bucketed `transient`, so it would flip to
`ctx.model`. This is rare (pre-flight already caught the usual bad-key case) and is not silent
- the enter-fallback warning fires. Falling back to the session model + notifying is an
acceptable degradation, not the masked-misconfig failure the non-goal targets.

### State machine

Per call, `target = controller.pickTarget(primary, ctx, isProbe)`: `primary` when
`!inFallback || isProbe`, else `fallback` (= `ctx.model`). After the call resolves,
`recordOutcome` applies the matrix below. Outcome x target grid (rows = classified outcome,
cells describe state change / notify / return for that target):

| Outcome | target = primary (initial or probe) | target = fallback (steady-state) |
|---|---|---|
| `success` | if this was a probe: **recover** - `inFallback=false`, info notify. Else no transition. Return summary. | no transition; return summary. |
| `transient` | retry **once** on `fallback`. If retry `success`: if `!inFallback` **enter fallback** (`inFallback=true`, `lastProbeAt=now`, warning notify); if probe, **stay** (`lastProbeAt=now`, no notify). Return the fallback summary; suppress the legacy `error` notify. If retry also `transient`: **both-down** (see below). | **both-down**: keep legacy `error` notify, return `null`, set/keep `inFallback=true`, `lastProbeAt=now`. |
| `auth` | pre-flight: return `null` as today, **no** fallback retry, no transition (keeps legacy auth notify). | return `null`, legacy auth notify, no transition. |
| `unusable` | return `null` as today. If this was a probe, treat as probe-inconclusive: **stay**, `lastProbeAt=now` (do not recover on a truncated probe). Else no transition. | return `null`, no transition. |
| `abort` | re-throw; no transition. | re-throw; no transition. |

Retry orchestration lives in `runSummarization`: a call targeting `primary` that returns
`transient` re-invokes the model run once against `fallback` in the same call before returning.
Calls already targeting `fallback` never retry.

**both-down messaging:** the enter-fallback warning is suppressed on a both-down event (the
fallback attempt failed, so nothing is "using the session model" yet). To avoid the user never
learning the session flipped, the warning fires on the **first subsequent flush where a
fallback call succeeds** (i.e. the warning is owed until an actual successful fallback run
emits it once).

Notify text (uses `model.name`; falls back to `provider/id` if `name` is empty):

- warning: `pi-condense: summarizer model <primary.name> failing, using session model <ctx.model.name> until it recovers`
- info: `pi-condense: summarizer model <primary.name> recovered`
- legacy (unchanged, `src/summarizer.ts` ~line 179): `pruner: summarization failed: <err.message>`; auth variant ~line 110: `pruner: summarization failed: <authMessage>`.

The legacy per-failure `error` notify is **suppressed when the fallback retry succeeds**
(otherwise the user gets error + warning for one event). It is kept for the both-down and
steady-state-fallback-failure cases.

### Probe / recovery

While `inFallback`, summarization keeps routing to `fallback`. On the **first flush after the
10-minute cooldown** (`now - lastProbeAt >= COOLDOWN_MS`), exactly **one** batch is elected as
the probe and routed to `primary`; the remaining batches stay on `fallback`. This bounds
steady-state doomed calls to **1 per cooldown interval**.

Probe election is via `claimProbe(batchIndex)`, not a raw "index 0" assumption. `Promise.all`
gives no completion-order guarantee, so:

- The **caller** iterating batches (before dispatch) calls `claimProbe` synchronously as it
  builds each batch's options; the first eligible index wins and `lastProbeAt` advances
  immediately, so no sibling in the same flush also claims. That batch's options carry
  `isProbe: true`.
- Probe **outcome** handling runs in that batch's own `recordOutcome` (keyed to its result),
  independent of when other batches settle - recovery is never triggered by a non-probe batch.
- Sequential progress path and single-batch / fusion calls: the probe is the **first eligible
  call of the flush** (`claimProbe` on the first batch index / the fusion call). A fusion-only
  flush may serve as the probe.

Probe `success` -> recover; probe `transient` -> stay, that batch retries on fallback (no work
lost), cooldown already reset by `claimProbe`; probe `unusable` -> stay (inconclusive).

`COOLDOWN_MS = 10 * 60 * 1000`, an internal constant in `src/summarizer-fallback.ts`.

### Cost / blast radius (honest notes)

- The **initial detection flush** can fire up to N primary calls: before the controller knows
  the model is down, `inFallback` is false, so every batch in that flush targets `primary`,
  fails, and retries on `fallback`. This is unavoidable - you cannot detect an outage without
  attempting the model. Steady-state is **0** doomed calls; re-probe is exactly **1** per 10
  minutes.
- Fallback calls run on `ctx.model` and their cost is attributed to the summarizer exactly as
  today (the `cost:external` / stats path is unchanged - it keys on the summarizer, not the
  model id).
- A session restart mid-outage yields a fresh controller (`inFallback=false`), so the next
  flush re-detects (one detection flush) and re-enters fallback. Acceptable per the
  no-persistence non-goal.
- Whole-provider outages (both primary and `ctx.model` down) fall through to the both-down
  `error` + `null` + retry-next-flush path. One behavior delta vs today: after such an outage
  ends, primary is re-tried only on the next 10-min probe (not every flush), so summarization
  runs on the (typically pricier) `ctx.model` for up to `COOLDOWN_MS` post-recovery before
  probing back. Bounded and acceptable; not "zero change".

## Testing approach

Unit tests over `FallbackController` with an injected clock and simulated call outcomes
(`transient-fail` / `success`), plus targeted `summarizer.ts` wiring tests:

- enter-fallback: primary transient fail -> fallback success flips `inFallback`, emits one
  warning.
- single-notify: N concurrent batches all failing primary emit **one** warning, not N.
- steady-state: while `inFallback`, non-probe batches route straight to `ctx.model`, never
  touch primary.
- cooldown gating: no probe before `COOLDOWN_MS`; exactly one probe batch after; `lastProbeAt`
  advances on probe.
- recover: probe success clears `inFallback`, emits one info.
- probe-fail: probe transient fail keeps `inFallback`, resets cooldown, probe batch still
  produces a summary via fallback.
- same-model no-op: `primary` equal to `ctx.model` -> controller inert, zero transitions,
  identical to current behavior.
- both-down: primary + fallback both transient-fail -> `error` notify preserved, `null`
  returned, `inFallback` set; owed warning fires on the next successful fallback call.
- both-down mixed error types (e.g. primary `stopReason==='error'`, fallback raw stream throw)
  -> same both-down handling.
- auth / unusable: neither trips the controller; probe returning `unusable` stays in fallback
  (no false recovery).
- abort: `signal.aborted` still re-throws, no transition.
- bypass coverage: sequential progress path, single-batch, and `summarizeRange` fusion calls
  all consult the controller (probe election + transitions), not just `summarizeBatches`.
- restart-mid-outage: `reset()` clears state; next flush re-detects and re-enters fallback.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: PRUNING.md (new "Summarizer outage fallback" subsection -
  state machine, transient-only trigger, sticky + 10-min re-probe, cost notes; clears the
  materiality bar as durable rationale for non-obvious runtime behavior). README.md gets a
  one-line mention in the summarizer/model section noting automatic fallback to the session
  model during a summarizer-model outage (no config).
- Derived / memory docs invalidated: AGENTS.md "Project Layout" list (add `src/summarizer-fallback.ts`);
  no customType table change (state is in-memory, not a `context-prune-*` entry).
