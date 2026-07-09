# Summarizer call timeout (idle + ceiling)

Date: 2026-07-09
Status: proposed
Area: `src/summarizer.ts`, `src/types.ts`, `src/config.ts`, `src/commands.ts`, docs

## Context

`runOnce` in `src/summarizer.ts` drives a `stream()` call with exactly one escape hatch: `options.signal` (the user's Esc). It has no time budget. The stream loop `for await (const event of responseStream)` and the trailing `await responseStream.result()` both block indefinitely if the provider accepts the connection but stalls (no bytes, no close — common under provider congestion).

The automatic flush paths (`turn_end`, `message_end`, `agent_end` in `index.ts`) call `flushPending` **without** a signal, and `flushPending` awaits summarization inline. So a stalled summarizer call hangs the whole agent turn with no user-visible cause and no recovery.

Measured on this laptop (32,122 real assistant-generation latency samples across all sessions; dominant model `claude-opus-4-8`), a **legitimate** summarizer call is not "a handful of seconds":

| Summarizer output size | median | p95 | p99 | observed max |
|---|---|---|---|---|
| ~800 tok (median call) | 12.9s | 29.3s | 40.7s | 331s |
| ~1.7-2k tok (p90-95) | 26.6s | 44.2s | 55.4s | 290s |
| ~2.8k tok (p99) | 40.7s | 62.7s | 76.3s | 256s |
| ~5k tok (max) | 64s | 92.5s | 124.6s | 208s |

Per-call output-token distribution (11,092 samples from consecutive `context-prune-stats` deltas): median 798, p95 2032, p99 2779 tokens.

Implication: a flat total-duration timeout that avoids false-aborting healthy calls would have to sit at ~200s+, and under the outage-fallback retry (below) a hang would then burn ~2x that before giving up. That is not an acceptable "short" bound.

## Problem

A stalled summarizer connection hangs the agent turn indefinitely. There is no timeout anywhere in the call chain, and the automatic flush paths pass no abort signal, so nothing can cancel it.

## Idea

Bound every summarizer call with a **two-part timeout inside `runOnce`**, driven by a local `AbortController` combined with the caller's `options.signal`:

1. **Idle (inactivity) timeout — primary mechanism.** A healthy stream emits `text_start` / `text_delta` / `text_end` events continuously (sub-second inter-token gaps). A true hang emits nothing. Arm a timer for `summarizerIdleTimeoutMs` **before** the loop (this covers time-to-first-token) and reset it on every stream event. If it fires, abort the stream. Because it measures silence, not total time, it never false-aborts a legitimately long-but-flowing generation regardless of output size.
2. **Total-duration ceiling — backstop.** A single timer for `summarizerMaxTimeoutMs` armed once at call start, never reset. Catches the pathological "slow-drip-forever" stream that keeps emitting a token every N < idle seconds but never completes. Generous by design: it only clips calls beyond the observed legitimate p99.

Both are configurable; `0` disables either independently.

A timeout classifies as **`transient`** so it flows through the existing outage-fallback state machine in `runSummarization` (option B): when a distinct `summarizerModel` is configured, a primary that times out gets the one existing session-model retry (itself bounded by the same idle+ceiling timeout). This is **not** a new retry loop — it reuses the machine that already exists for provider outages. When `summarizerModel` is `"default"` (no distinct fallback), the single attempt times out, warns, and drops the batch (retried on the next natural flush; frontier does not advance).

A timeout is surfaced to the user via `ctx.ui.notify(..., "warning")` with timeout-specific wording, distinct from the existing `"error"`-severity API-failure notice.

### Values (grounded in the data above)

| Setting | Default | Rationale |
|---|---|---|
| `summarizerIdleTimeoutMs` | `20000` (20s) | Healthy inter-token gaps are sub-second; the only real spike is TTFT under congestion (~<3s, occasionally ~10s). 20s gives comfortable headroom over TTFT while catching a silent hang fast. Values < 15s risk false-aborting TTFT spikes. |
| `summarizerMaxTimeoutMs` | `180000` (180s / 3 min) | Clears every observed p99 (max p99 was 124.6s) with headroom; only clips pathological multi-minute outliers (208-331s completed calls, i.e. provider degradation). Pure backstop. |

Worst-case wall-clock for a genuine silent hang under option B: `idle` (primary stalls, ~20s) + `idle` (session-model retry also stalls, ~20s) = ~40s, then one warning + drop. The 180s ceiling only participates when a stream is dribbling (never goes fully idle) yet never finishes.

## Design

### Config (`src/types.ts`)

Add two fields to `ContextPruneConfig` and `DEFAULT_CONFIG`:

```ts
/**
 * Idle (inactivity) timeout for a single summarizer stream call, in ms.
 * Reset on every received stream event; armed before the first event so it
 * also bounds time-to-first-token. If no event arrives within this window the
 * call is aborted and classified transient (feeds the outage-fallback retry).
 * 0 disables the idle timer. Default 20000.
 */
summarizerIdleTimeoutMs: number;
/**
 * Total-duration ceiling for a single summarizer stream call, in ms. Armed
 * once at call start, never reset — a hard upper bound that catches a stream
 * that keeps dribbling events but never completes. Same transient/warning
 * handling as the idle timeout. 0 disables the ceiling. Default 180000.
 */
summarizerMaxTimeoutMs: number;
```

`DEFAULT_CONFIG`: `summarizerIdleTimeoutMs: 20000`, `summarizerMaxTimeoutMs: 180000`.

Add two preset arrays for the settings overlay (strings, `"0"` = disabled sentinel), mirroring the existing `*_PRESETS` pattern:

```ts
export const IDLE_TIMEOUT_PRESETS = [
  { value: "0", label: "0 (disabled)" },
  { value: "10000", label: "10s" },
  { value: "20000", label: "20s (default)" },
  { value: "45000", label: "45s" },
  { value: "90000", label: "90s" },
];
export const MAX_TIMEOUT_PRESETS = [
  { value: "0", label: "0 (disabled)" },
  { value: "120000", label: "120s" },
  { value: "180000", label: "180s (default)" },
  { value: "300000", label: "300s" },
  { value: "600000", label: "600s" },
];
```

### Normalization (`src/config.ts`)

In `normalize()`, clamp both like the existing `minBatchChars` guard: finite `number >= 0` → `Math.floor(value)`, else the default. `0` is a valid (disabling) value, so the guard is `>= 0`, not `> 0`.

### `runOnce` (`src/summarizer.ts`) — the core change

- Extend the existing `transient` variant with an **optional** `timedOut` field — it keeps `message` (do not drop it or add a new variant):
  ```ts
  | { kind: "transient"; message: string; timedOut?: boolean }
  ```
- Read the budgets from config at the top of `runOnce`:
  ```ts
  const idleMs = config.summarizerIdleTimeoutMs;
  const maxMs = config.summarizerMaxTimeoutMs;
  let timedOut = false;
  let timeoutKind: "idle" | "ceiling" | null = null;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimerId: ReturnType<typeof setTimeout> | null = null;
  ```
- `combineSignals` is a small local helper (inline in `summarizer.ts`), tolerant of an absent caller signal:
  ```ts
  function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
    const present = signals.filter((s): s is AbortSignal => !!s);
    if (present.length === 0) return undefined;
    if (present.length === 1) return present[0];
    return AbortSignal.any(present); // Node 20+; host runtime is node 24.5.0
  }
  ```
  Build a local `AbortController` (`timeoutController`) and pass `stream(..., { signal: combineSignals(options.signal, timeoutController.signal), ... })`.
- Idle timer: a helper `bumpIdle()` that `clearTimeout(idleTimerId)` and, when `idleMs > 0`, re-arms `idleTimerId = setTimeout(() => { timedOut = true; timeoutKind = "idle"; timeoutController.abort(); }, idleMs)`. Call `bumpIdle()` once before the loop (covers TTFT), then inside the loop **on every received event** — not only `text_*`. Reasoning-capable summarizer models (`summarizerThinking` wires `reasoningEffort`) emit `thinking_start`/`thinking_delta`/`thinking_end` (pi-ai `types.d.ts:275-287`); bumping on any event keeps a legitimately-reasoning-but-quiet stream alive, so extended reasoning never false-aborts. `reportTextProgress` stays gated to `text_*` events (unchanged).
- Ceiling timer: `ceilingTimerId = setTimeout(() => { timedOut = true; timeoutKind ??= "ceiling"; timeoutController.abort(); }, maxMs)` when `maxMs > 0`, armed once at call start.
- Clear both timers in a `finally` (`clearTimeout(idleTimerId); clearTimeout(ceilingTimerId);`) so no timer leaks after the call returns or throws.
- Classification (centralize so no transient site escapes it): a timeout abort can surface either as a throw in the catch OR as `response.stopReason === "error"` (pi-ai's error event, `types.d.ts:307`). At **every** transient return site — the `stopReason === "error"` branch and the catch — set `timedOut`/`timeoutKind` into the outcome: if `timedOut && !options.signal?.aborted`, return `{ kind: "transient", timedOut: true, message: <worded by timeoutKind> }` — e.g. `` `summarizer ${modelLabel(model)} stalled (no output for ${idleMs / 1000}s)` `` for idle, `` `summarizer ${modelLabel(model)} exceeded ${maxMs / 1000}s ceiling` `` for ceiling. A simple way: compute the timeout message once from `timeoutKind` and prefer it whenever `timedOut` is set, at both sites.
- User abort is unchanged: `options.signal?.aborted` still short-circuits and re-throws so `flushPending` restores state silently. The timeout controller aborting does **not** set `options.signal.aborted` (it is a separate controller), so a timeout is never misclassified as a user abort.

### `runSummarization` (`src/summarizer.ts`) — warning severity

Replace the bare `notifyError` sites with a helper that picks severity from the outcome. Wording is **path-neutral** — `runSummarization` is shared by `summarizeBatch` and `summarizeRange`, and a timed-out range fusion neither "drops a batch" nor "retries next flush" (it falls back to per-batch concat at render, see below), so the message must not assert batch semantics:

```ts
const notifyFailure = (o: { message: string; timedOut?: boolean }) =>
  ctx.ui.notify(
    o.timedOut
      ? `pi-condense: ${o.message}; summarizer call abandoned`
      : `pruner: summarization failed: ${o.message}`,
    o.timedOut ? "warning" : "error",
  );
```

Threaded through:
- Legacy no-fallback path: `case "transient": notifyFailure(r); return null;`
- Fallback path, fallback-only fail: `notifyFailure(r)`.
- Fallback path, both-down: `notifyFailure(r2.kind === "transient" || r2.kind === "auth" ? r2 : r)` — preserves today's exact message-selection (the auth arm must stay: a session-model auth failure after a primary timeout should surface the auth error, not the stale timeout message) and carries whichever `timedOut` flag applies.
- Fallback rescue (primary times out, session model succeeds): no failure notice; the existing `"enter"` fallback warning (`summarizer model X failing, using session model Y until it recovers`, already `"warning"` severity) fires via `emit`. A timeout is treated exactly like any transient here. **Scope note:** the "every timeout gets timeout-specific wording" guarantee applies to **non-rescued** timeouts only; a rescued primary timeout is reported solely as the generic fallback-entry warning. This is intentional — the rescue path is not a failure and does not warrant a second, redundant notice.

No change to the `FallbackController` itself: a timeout is a transient, and the controller already handles transient primary → session retry → sticky-until-probe. Option B falls out of the existing machine for free.

### Commands / UI (`src/commands.ts`)

- **Imports:** export `IDLE_TIMEOUT_PRESETS` / `MAX_TIMEOUT_PRESETS` from `src/types.ts` and import them in `src/commands.ts` alongside the existing `MIN_BATCH_CHARS_PRESETS` etc.
- **SettingsList entries:** add two entries in the settings overlay (placed after `recoveryGraceTurns`), each using its preset array via `values: PRESETS.map((p) => p.value)` with the same `currentValue`-in-cycle fallback as `minBatchChars` (fall back to the default preset value when the stored value is not in the cycle). Description text states the disabling sentinel (`0`) and the idle-vs-ceiling distinction.
- **`onChange` wiring (required):** every setting has an explicit `id`-matched branch in the overlay's `onChange` handler; a `SettingsList` entry without one renders but never persists. Add branches for `summarizerIdleTimeoutMs` and `summarizerMaxTimeoutMs` that `parseInt` the new value, clamp `>= 0` (fall back to the default on NaN/negative), assign to `newConfig`, and refresh the description — mirroring the `minBatchChars` branch.
- **`/pruner status`:** append two lines alongside the existing model/thinking lines, formatted `idle timeout: 20s` / `max timeout: 180s`, rendering `disabled` when the value is `0`.
- **Out of scope:** dedicated `/pruner idle-timeout` / `/pruner max-timeout` subcommands. The settings overlay + `settings.json` are the surfaces; a bespoke subcommand each is YAGNI. Add later if asked.

## Error handling and edge cases

- **Idle disabled (`0`), ceiling set:** only the ceiling timer arms. The ceiling `setTimeout` is armed at call start and fires on schedule regardless of stream activity (JS timers are not blocked by a pending `await`), so even a stream that never yields its first event is still caught — at the ceiling (up to 180s), not fast. Accepted; it is the user's explicit choice. With **both** disabled there is no first-token bound at all (see next).
- **Both disabled (`0`/`0`):** exact current behavior (no timeout), including no first-token bound — a stream that never yields hangs indefinitely, the pre-feature bug. Preserved deliberately as the escape hatch for anyone who hits false aborts.
- **Reasoning summarizer models:** because the idle timer resets on `thinking_*` events too (not just `text_*`), a model doing long extended reasoning before emitting text keeps the idle timer alive and is not false-aborted. Residual risk only if a provider streams reasoning with inter-event gaps beyond `summarizerIdleTimeoutMs`; mitigation is to raise it.
- **User Esc during a bounded call:** `options.signal` fires; the combined signal aborts the stream; the existing `options.signal?.aborted` checks re-throw the abort so `flushPending` restores state. Not classified as a timeout (no warning).
- **Timeout fires after the stream already completed:** the `finally` clears both timers on the normal-completion path before they can fire; a race where the timer fires between `result()` resolving and cleanup is harmless (the outcome is already built; aborting a settled stream is a no-op).
- **Parallel batches (`summarizeBatches`):** each `runOnce` owns its own timeout controller, so one batch timing out does not abort its siblings; each is independently classified.
- **Range fusion (`summarizeRange`) and per-batch both** route through `runSummarization` → `runOnce`, so both inherit the timeout with no extra code. On a range-fusion timeout, `runSummarization` returns `null`; `compressEligible` then proceeds **without** `rangeSummaryText`, and the renderer falls back to the per-batch concatenation (per `ChainCompressionEntry.rangeSummaryText` semantics). The chain is still compressed — only the fused summary is skipped. This is why the warning wording is batch-neutral.
- **Timer leak:** `finally` clears both `setTimeout` handles on every exit path (success, unusable, transient, throw).

## Testing approach

`bun test src/` — extend `src/summarizer-wiring.test.ts` (its `mock.module` swap of `stream` and note-capturing `ctx` are the right harness). **Mock-harness change required:** the current stub is `stream: (model: any) => streamImpl(model)`, which drops the options/signal argument, so a hanging stream cannot observe the abort. Change it to forward all args — `stream: (...args: any[]) => streamImpl(...args)` — and type `streamImpl` as `(model, input, opts)` so helpers can read `opts.signal`. Add a `hangingStream(signal)` helper whose async iterator awaits a promise that rejects when `signal` aborts, and whose `result()` likewise never resolves until abort. Drive with a tiny `summarizerIdleTimeoutMs` (e.g. `20`) so tests run fast.

Cases:
1. **Idle timeout → transient + warning.** `summarizerModel: "default"`, hanging stream, `summarizerIdleTimeoutMs: 20`. Assert `summarizeBatch` returns `null`, one note at level `"warning"` whose text mentions stalling.
2. **Ceiling timeout → transient + warning.** Idle disabled (`0`), tiny `summarizerMaxTimeoutMs`, a stream that dribbles events forever (never idles). Assert ceiling warning fires.
3. **Option B: primary idle-times-out, session model rescues.** Distinct `summarizerModel`, controller present; `streamImpl` returns a hanging stream for `PRIMARY` and an `okStream` for `SESSION`. Assert result is the session summary, `"enter"` fallback warning present, no failure notice.
4. **Both time out → both-down warning.** Distinct model; both models hang. Assert `null` + `onBothDown`-path warning at `"warning"` level.
5. **User abort is not a timeout.** Pre-aborted `options.signal`; assert the call throws (propagated abort) and no `"warning"` note is pushed.
6. **Disabled (`0`/`0`) → no timer, unchanged behavior.** Existing ok/err wiring tests still pass with the new fields defaulted; add one asserting an `okStream` succeeds with both timeouts `0`.

## Documentation impact
- Feature / user-facing docs introduced: none.
- Materially amended existing docs: `doc/configuration.md` and `CHANGELOG.md` (one entry). `README.md` settings table lists only a subset, so no change there. The exact `doc/configuration.md` deltas:
  - Two rows in the "Every key" table:
    ```
    | `summarizerIdleTimeoutMs` | non-negative integer (ms), `0` disables | `20000` | Abort a summarizer stream call after this much silence (no stream event). Resets on every event, so it never false-aborts a flowing generation; catches a stalled connection fast. A timeout feeds the same outage-fallback retry as a provider error. `0` = no idle bound. |
    | `summarizerMaxTimeoutMs` | non-negative integer (ms), `0` disables | `180000` | Hard ceiling on total duration of a single summarizer stream call. Backstop for a stream that dribbles forever without going idle. Generous by design (clears the observed p99). `0` = no ceiling. |
    ```
  - Two keys added to the "Full settings JSON" sample (after `summarizerThinking`): `"summarizerIdleTimeoutMs": 20000,` and `"summarizerMaxTimeoutMs": 180000,`.
  - A short "Summarizer timeouts" subsection near the existing outage-fallback note (line ~98): idle-vs-ceiling distinction, that a timeout classifies as transient and feeds the same session-model fallback retry, and that both tries are timeout-bounded.
- Derived / memory docs invalidated: none. (`AGENTS.md` project-layout and customType tables are unaffected — no new session entry types, events, or `src/*.ts` files; the change is confined to existing files.)
