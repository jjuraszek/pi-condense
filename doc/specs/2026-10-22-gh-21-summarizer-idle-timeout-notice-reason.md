# Summarizer idle timeout 45s default and failure reason in the fallback notice

Date: 2026-10-22
Status: proposed
Ticket: jjuraszek/pi-condense#21
Area: `src/types.ts`, `src/summarizer.ts`, `src/summarizer-wiring.test.ts`, `doc/configuration.md`, `CHANGELOG.md`

**Goal:** A summarizer provider that queues for up to 45s before its first token completes normally instead of tripping the outage fallback, and when the session model does rescue a call the fallback-entry notice names why the primary failed.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.

supersedes `doc/specs/2026-07-09-summarizer-call-timeout.md`, the "Fallback rescue" scope note (a rescued timeout is reported solely as the generic fallback-entry warning) and the 20s default in its Defaults table.

## Problem

`runOnce` in `src/summarizer.ts` arms the idle timer before the first stream event (`bumpIdle()` at line 199) and resets it on every event, so `summarizerIdleTimeoutMs` bounds time-to-first-token as well as mid-stream silence. The default is 20000 (`src/types.ts:572`), chosen in the 2026-07-09 spec from a first-token estimate of under 3s, occasionally 10s. The reporter's sample from a queueing provider (GLM 5.3 Flash via a separate summarizer config) shows 15 first-token latencies of 2.8-7.6s, one of 14.7s, and five of 35-39.5s; a repeat of a 38s request returned in 3-5s. Each such call is aborted as `summarizer <label> stalled (no output for 20s)`, classified transient, retried on the session model, and reported as `pi-condense: summarizer model <X> failing, using session model <Y> until it recovers` - a notice that says nothing about what failed (`src/summarizer.ts:312-321`).

Framing: kept (ticket #21). The ticket records the reporter's decision to reject a separate first-token budget and a doubled-budget same-model retry; the root cause (one timer for TTFT and silence) stays, and this spec moves the default. The 45s value is already a `SUMMARIZER_IDLE_TIMEOUT_PRESETS` entry (`src/types.ts:220-224`).

Cost of the move: the flush is awaited inside the `turn_end` and `message_end` handlers (`index.ts:1011`, `index.ts:1027`) and pi awaits `turn_end` as a boundary before the next turn (`_dispatchTurnEndBoundary`, `agent-session.js:488-520`), so a primary that never answers holds the session for the full idle budget before the session model takes over. That wait grows from 20s to 45s. It is paid by the flush that first detects the silent primary and again by each failed cooldown probe (one probe per `COOLDOWN_MS`, 10 minutes, `src/summarizer-fallback.ts:16,65-70`); intervening calls route directly to the session model. A flush whose session-model retry also stalls waits a second idle budget (90s both-down). 45s is a per-attempt idle budget, not a whole-flush worst case.

Premise corrections carried from the questionary: the `["idle", 20, 0, /stalled/]` fixture passes 20 milliseconds as an explicit override and encodes no default; a timeout `RunOutcome.message` carries a `summarizer <label>` prefix that the ticket's example notice omits; `summarizerMaxTimeoutMs` is armed per attempt, not per flush. Each is resolved in Design.

## Acceptance criteria

Ticket jjuraszek/pi-condense#21, "Acceptance criteria", rows verbatim:

- [ ] On a fresh config, `summarizerIdleTimeoutMs` resolves to 45000 and `/pruner status` reports the idle timeout as 45s.
  in-scope
- [ ] With a summarizer provider that emits its first token after 25s of silence and no timeout overrides, the summarizer returns the summary and no `summarizer model ... failing, using session model ...` notice is printed.
  in-scope
- [ ] With the same provider and `summarizerIdleTimeoutMs: 20000`, the call is aborted at 20s, the batch is summarized by the session model, and the fallback notice is printed (the existing outage-fallback behavior is unchanged).
  in-scope
- [ ] A summarizer provider that emits a first token and then produces no further output for longer than `summarizerIdleTimeoutMs` is aborted with the reason `stalled (no output for <N>s)`, that reason appears in the fallback notice when the session model rescues the call, and the flush ends within `summarizerMaxTimeoutMs`.
  in-scope
- [ ] When the session model rescues a call, the fallback notice carries the primary's failure reason verbatim, e.g. `pi-condense: summarizer model <X> failing (stalled (no output for 45s)), using session model <Y> until it recovers`; a provider error carries that error's message in the same slot.
  in-scope
- [ ] `doc/configuration.md` (the settings reference README routes to), `CHANGELOG.md`, and a `doc/specs/` entry state the new default and that a silent summarizer provider now waits 45s instead of 20s before the session model takes over; the tests that encode the 20s default (the `["idle", 20, 0, /stalled/]` fixture in `src/summarizer-wiring.test.ts`) are updated.
  in-scope

Readings of ambiguous rows (Design clauses):

- Row 4, "the flush ends within `summarizerMaxTimeoutMs`": the ceiling stays per attempt (`src/summarizer.ts:190-196`), and per-attempt timers do not bound the flush. A primary that emits one token, stalls at the idle budget, and is rescued by a session model that keeps streaming finishes after idle budget plus rescue duration; measured with idle 120ms and ceiling 400ms, the rescued call returned at 497ms. Approach 1 ("be minimal") adds no whole-flush deadline. Settled at the gate (reading A): the clause is read as "each attempt ends within `summarizerMaxTimeoutMs`", which the per-attempt ceiling guarantees; the row's first two clauses (abort reason `stalled (no output for <N>s)`, reason in the rescue notice) are satisfied as written.
- Row 5, "verbatim": the slot carries the primary `RunOutcome.message` unchanged; for timeout outcomes that message becomes prefix-free (`stalled (no output for 45s)`, `exceeded 180s ceiling`) so the notice matches the row's example and does not nest the model label twice. "When the session model rescues a call" means the controller was not in fallback before the call (`controller.inFallback === false`, read before `onPrimaryFailFallbackOk`). A rescued probe failure while already in fallback keeps today's behavior whether the controller returns `none` or the deferred `enter` owed by an earlier both-down call (`src/summarizer-fallback.ts:75-86`). A reason is present when it is a non-empty string; an empty provider message prints today's notice.
- Row 6, "tests that encode the 20s default ... are updated": accepted premise correction - no test encodes the default; the fixture's 20 is milliseconds (`Math.round(20 / 1000)` renders `0s`). The row is met literally: the fixture keeps its fast override and gains a one-line comment naming its millisecond scale, and a default assertion is added.

## Design

### Default (`src/types.ts`)

- `DEFAULT_CONFIG.summarizerIdleTimeoutMs` becomes `45000`.
- In `SUMMARIZER_IDLE_TIMEOUT_PRESETS` the `(default)` tag moves from the `20000` label to the `45000` label; the doc comment at line 324 ("Default 20000") follows.
- Nothing else changes: `src/config.ts` normalizes against `DEFAULT_CONFIG`, `/pruner settings` matches presets against `DEFAULT_CONFIG`, and `/pruner status` renders `idle to:` from the resolved value (`src/commands.ts:883-889`), so each reports 45s without edits. An explicit `20000` or `0` in user config keeps its meaning.

### Reason in the notice (`src/summarizer.ts`)

- `timeoutMessage` in `runOnce` returns the prefix-free form: `stalled (no output for ${N}s)` and `exceeded ${N}s ceiling`. The timer layout is untouched (idle armed before the first event, reset on every event, ceiling per attempt).
- `notifyFailure` becomes `notifyFailure(model, outcome)` and prepends `summarizer ${modelLabel(model)} ` to timed-out outcomes of both kinds (idle and ceiling both return `timedOut: true`, `src/summarizer.ts:240,256`), so the non-rescued lines keep today's text and severity: `pi-condense: summarizer <label> stalled (no output for 45s); summarizer call abandoned` and `pi-condense: summarizer <label> exceeded 180s ceiling; summarizer call abandoned`, both `warning`. `RunOutcome` gains no field; each call site passes the model it attempted: legacy single-attempt path `primary`; controller auth failure `model`; fallback-only failure `model` (the session model, since `r` on that path came from `sessionModel`); both-down `sessionModel` when `r2` is chosen, else `model`.
- `emit` takes an optional reason; a reason is present when it is a non-empty string. On the immediate-rescue path (`r2.kind === "ok"` after a transient primary failure) the caller reads `const wasInFallback = controller.inFallback` before `onPrimaryFailFallbackOk` and calls `emit(controller.onPrimaryFailFallbackOk(decision.wasProbe), wasInFallback ? undefined : r.message)`. When the transition is `enter` and a reason is present the notice is `pi-condense: summarizer model <X> failing (<reason>), using session model <Y> until it recovers`; otherwise it is today's text. Provider errors flow through unchanged (`response.errorMessage` or `err.message`), with no truncation or whitespace handling; an empty message omits the parenthetical.
- The deferred `enter` owed by an earlier both-down call fires either from `onFallbackSuccess` (`src/summarizer-fallback.ts:117-123`) or from `onPrimaryFailFallbackOk` when a later probe fails and is rescued (`src/summarizer-fallback.ts:77-80`); both print today's text with no reason (user decision B). The primary reason is unavailable on that path: the both-down line prints the chosen outcome, which prefers `r2` (the session model's failure, `src/summarizer.ts:349-350`), so the primary reason may never have been displayed. `FallbackController` is not modified; `inFallback` is already a public field.

### Predecessor

`doc/specs/2026-07-09-summarizer-call-timeout.md` gets a supersession banner naming this spec for its rescued-timeout scope note and its 20s default. Its timer semantics, settings surface, and ceiling default stand. `doc/specs/2026-07-06-summarizer-outage-fallback.md` minted the notice wording; this spec extends that wording and does not supersede it.

## Errors and edge cases

- Timer disabled (`summarizerIdleTimeoutMs: 0`): unchanged; the 45s default applies only when the key is absent.
- Ceiling timeout on the primary, rescued by the session model: notice reason is `exceeded 180s ceiling`.
- Rescued probe failure while already in fallback: no reason is passed. The controller returns `none` (nothing printed) or, when an earlier both-down call left the enter warning owed, `enter` with today's reason-free text.
- Both models fail: `notifyFailure` prints the chosen outcome (`r2` when transient or auth, else `r`) with that outcome's model label; the later deferred `enter` prints without a parenthetical.
- Primary fails with an empty provider message (`err.message === ""` or `response.errorMessage === ""`), session model rescues: the notice is today's text, no `()`.
- Auth and unusable outcomes never reach the rescue path (unchanged classification).
- User abort (`options.signal`) is re-thrown before any notice (unchanged).

## Tests

`src/summarizer-wiring.test.ts` (existing harness: `distinctConfig`, `hangingStream`, `okStream`, `drippingStream`, `makeCtx(notes)`):

- `DEFAULT_CONFIG.summarizerIdleTimeoutMs === 45000`, and exactly one `SUMMARIZER_IDLE_TIMEOUT_PRESETS` label carries `(default)`, on the `45000` entry.
- `/pruner status` with a config that omits `summarizerIdleTimeoutMs` renders `idle to:  45s` (`src/commands.test.ts`, rendered by `fmtTimeout` from the resolved value, `src/commands.ts:883-889`).
- Delayed first token under the resolved default (row 2): config omits `summarizerIdleTimeoutMs`; the primary's first event lands after the old 20s budget and before 45s on controlled time (stubbed timer clock), or in a separately bounded integration check when the harness cannot drive the timers; assert the summary is returned and no warning is printed.
- Same delayed stream with explicit `summarizerIdleTimeoutMs: 20000` (row 3): the primary is aborted at 20s, the session model answers, one `enter` warning is printed. Scale the two scenarios together (first token at 25/45 of the budget) only when the harness drives real timers.
- Token then silence (row 4): primary emits one event (`drippingStream(opts, text, 1, gapMs)`) and stalls past the idle budget; session model rescues; one warning matching `/summarizer model .* failing \(stalled \(no output for \d+s\)\), using session model/`, no errors. No whole-flush duration assertion; the row's ceiling clause is per attempt (see Acceptance criteria, row 4).
- Primary fails with a provider error (`errorMessage: "boom"`), session model rescues: warning contains `failing (boom), using session model`.
- Primary fails with an empty provider message, session model rescues: warning equals today's text, no `(`.
- Both-down, then a later fallback-only success: the `enter` warning contains no `(` before `, using session model`.
- Both-down, then a failed probe rescued by the session model (`owedEnterWarning` set, controller returns `enter` from `onPrimaryFailFallbackOk`): the `enter` warning contains no `(` before `, using session model`.
- Non-rescued idle and ceiling timeouts lock the exact text and severity: `pi-condense: summarizer <label> stalled (no output for 0s); summarizer call abandoned` and `pi-condense: summarizer <label> exceeded 0s ceiling; summarizer call abandoned`, both `warning`, where `<label>` is the attempted model; the fallback-only failure case asserts the session model's label.
- The `["idle", 20, 0, /stalled/]` fixture keeps its 20ms override and gains a comment naming the millisecond-scale timer scenario; its assertion is unchanged.
- Existing expectations stay green unchanged: the `; summarizer call abandoned` fragment checks, the both-timeout case's one-warning/zero-error counts, idle reset while events flow, disabled timers, user abort.

Validation: `bun test src/`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/configuration.md` (operations / tunable parameters) - the JSON example (line 19), the settings table row (line 58), and the "Summarizer timeouts" bullet (line 135) state 45s; the bullet's existing sentence "It also bounds time-to-first-token." stays, and one sentence is added: 45s covers queueing providers at the cost of a 45s silent-primary wait on initial detection and on each failed 10-minute probe, with intervening calls routed to the session model; `CHANGELOG.md` (operations) - new `## [Unreleased]` entry for the default change and the reason-in-notice; `doc/specs/2026-07-09-summarizer-call-timeout.md` (non-obvious rationale) - supersession banner per the Predecessor clause
- Derived / memory docs invalidated: none - `README.md` and `PRUNING.md` do not state the idle default

## Out of scope

- A separate first-token budget (`summarizerFirstTokenTimeoutMs`) and a doubled-budget same-model retry: rejected in ticket #21.
- A whole-flush deadline across primary and fallback attempts (approach 1, "be minimal"); ticket row 4's ceiling clause is read per attempt (see Acceptance criteria).
- Carrying a primary reason into the deferred `enter` notice (user decision B; the primary reason is unavailable on that path without new state).
- Truncating or collapsing long provider error text in the notice.
- Changing `minBatchChars` or any other call-count knob.

## Open questions

- Settled at the gate: ticket row 4's "the flush ends within `summarizerMaxTimeoutMs`" is read per attempt (reading A); a whole-flush deadline is out of scope. Probe that motivated the question: ceiling armed per `runOnce` (`src/summarizer.ts:190-199`); a bounded `bun --eval` against `summarizeBatch` with idle 120ms, ceiling 400ms, primary token-then-stall, fallback streaming 360ms returned at 497ms.
- 45s moves the cliff rather than removing it: the reporter's sample has 35-39.5s first-token latencies, so a provider that queues longer still trips fallback. If that recurs, the first-token budget rejected in #21 is the root-cause fix (idle timer doubles as TTFT bound, `src/summarizer.ts:199`) and warrants its own ticket.
