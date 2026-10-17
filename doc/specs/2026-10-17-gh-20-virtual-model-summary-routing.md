# Route summarizer calls through the model registry so virtual models work

**Goal:** A virtual model works as the summarizer - whether it arrives via `summarizerModel: "default"`, an explicit virtual `provider/id`, or as the outage-fallback target - because every summarizer LLM call goes through `ctx.modelRegistry.streamSimple()`, the one Pi facade that routes virtual models.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Date:** 2026-10-17
**Status:** proposed
**Ticket:** jjuraszek/pi-condense#20

## Problem

The summarizer makes exactly one kind of LLM call: `stream()` imported from `@earendil-works/pi-ai/compat` inside `runOnce` (`src/summarizer.ts:1`, `:169-182`). That function dispatches by `model.api` through a static provider table; a virtual model carries `api: "pi-virtual"` (`pi-coding-agent/dist/core/virtual-models.js:3,72`) and the table has no such entry, so `resolveApiProvider()` throws `No API provider registered for api: pi-virtual` (`pi-ai/dist/compat.js:163-167`). The pre-stream auth check does not help: for a virtual model on a provider with no physical catalog the keyless virtual provider resolves an empty credential and `getApiKeyAndHeaders` returns `ok: true` (`virtual-models.js:97`, `model-registry.js:34-50`), so the user sees the `pi-virtual` error; for a virtual model registered under an existing keyed provider (`withVirtualModels` keeps that provider's auth, `virtual-models.js:100-122`) a missing key fails the pre-check first and the same dispatch bug is reported as `auth`. Either way the check is wrong for virtual models, which is why Design skips it for them.

Every path that resolves to a virtual model fails the same way: `summarizerModel: "default"` (which `resolveModel` maps to `ctx.model`, `src/summarizer.ts:52-79`), an explicit virtual `provider/id` found in the registry, and the outage-fallback target (`sessionModel = ctx.model`, `src/summarizer.ts:281`). The reporter saw the fallback case: a pinned free-tier primary timed out, the controller switched to the virtual session model, and every fallback attempt threw the `pi-virtual` error until the primary probe succeeded after `COOLDOWN_MS`. Batches were retained, not lost, but no summaries were produced for the duration.

The fallback controller (`src/summarizer-fallback.ts`) is a pure state machine with no model IO and is not at fault; the reporter's original sketch of picking the last physical model from branch history was retracted in the ticket's comment. The fix is at the dispatch seam.

Side effect of the seam change, recorded here so the CHANGELOG owns it: the current thinking option `reasoningEffort` (`src/summarizer.ts:41-47`) is API-specific and read only by the OpenAI-style adapters; `anthropic-messages.js` has no reference to it, so `summarizerThinking` silently does nothing on Anthropic-style providers today. `streamSimple` takes a provider-neutral `reasoning: ThinkingLevel` (`pi-ai/dist/types.d.ts:227-237`), so the setting starts applying on every provider.

Framing: kept - the ticket's Idea already names the dispatch seam (`ctx.modelRegistry.streamSimple`) and the controller stays untouched. Checked `compat.js`, `model-runtime.js` `streamSimple` (`:494-513`), `model-registry.js`, `virtual-models.js`, `lazy.js`, and the `summarizeBatch`/`summarizeRange` -> `runSummarization` -> `runOnce` call chain. `ctx.modelRegistry.stream()`/`.complete()` were considered and rejected: for virtual models they land on `unroutedStream` and throw `must be routed before streaming` (`virtual-models.js:83-86,120-121`).

## Acceptance criteria

Ticket jjuraszek/pi-condense#20, "Acceptance criteria", rows verbatim:

- [ ] Given a transiently failing pinned concrete summarizer and a virtual session selection routing to a distinct healthy concrete model, batch and range summarization return non-whitespace, non-truncated fallback summaries without a `pi-virtual` provider error, and successful fallback emits the existing enter warning once.
  in-scope
- [ ] Given a registered virtual summarizer selected through `default` or an explicit `provider/model-id`, batch and range summarization return non-whitespace, non-truncated summaries using the router's direct-request choice, including with no earlier assistant response.
  in-scope
- [ ] Given a direct-request choice different from the last responding model, requesting a summary uses the direct-request choice and leaves the session selection and persisted router state unchanged.
  in-scope
- [ ] Given successful fallback, calls before `COOLDOWN_MS` use fallback; concurrent calls after the cooldown elect one primary probe, and a successful probe restores primary use with one recovery notice, preserving the existing controller behavior.
  in-scope
- [ ] Given a virtual router that throws or selects a model without credentials and no successful alternate, flushing reports failure and retains unsummarized batches for retry rather than recording them as summarized.
  in-scope

Readings adopted as Design clauses: rows 2 and 3 are satisfied by `streamSimple`'s own direct-routing branch (`reason: "direct"`, stateless, router state ignored - `model-runtime.js:494-513`, Pi `docs/virtual-models.md` "direct requests have no state"); pi-condense adds no routing or history inspection. Row 4 is satisfied by leaving `src/summarizer-fallback.ts` unchanged. Row 5 is satisfied because every `streamSimple` failure classifies `transient` and the existing flush path already retains batches on a null summary.

## Design

### Compatibility policy

Unconditional `ctx.modelRegistry.streamSimple`. No feature detection, no legacy `compat.stream` path. The registry method exists from Pi 0.86.0 and routes virtual models from Pi 0.99.0 (per the coding-agent CHANGELOG at v1.3.0); the types this repo compiles and tests against are 1.3.0.

- `devDependencies`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` move from `^0.83.0` to `^1.3.0` (`package.json:60-62`).
- `peerDependencies` stay `*` (`package.json:54-56`).
- README states the minimum host version: Pi >= 1.3.0.
- Hosts before 1.3.0 are unsupported. A host before 0.86.0 has no `streamSimple`: the call throws `TypeError`, `runOnce` classifies it `transient`, and the user sees the standard summarizer-failure notice carrying the message. Hosts in 0.86.0..1.2.x have the method but are not tested or claimed; no guard either way.
- `bun install` after the bump creates `bun.lock`; the repo has never tracked a lockfile and CI runs bare `bun install`, so `bun.lock` is added to `.gitignore` beside `package-lock.json`.

### Dispatch (`runOnce`, `src/summarizer.ts`)

One function changes. Its contract - one attempt against one model, returning `ok | auth | unusable | transient` - is unchanged.

| Today | After |
|---|---|
| `import { stream } from "@earendil-works/pi-ai/compat"` | import removed |
| `getApiKeyAndHeaders(model)`; `ok: false` -> `{ kind: "auth" }` | same, but only when `model.api !== "pi-virtual"`; a virtual model skips the pre-check |
| `getProviderAuth(model.provider)?.auth.baseUrl` copied onto an `effectiveModel` (`:158-166`, Copilot seat comment) | deleted; `prepareRequest` inside `streamSimple` applies the same override (`model-runtime.js:452-481`) |
| `stream(effectiveModel, ctx, { apiKey, headers, signal, ...thinking })` | `ctx.modelRegistry.streamSimple(model, context, { signal, ...thinking })` - no `apiKey`/`headers`; the registry resolves them. No `maxTokens` today, none after: output budget stays with the registry/provider defaults |
| event loop over `AssistantMessageEventStream`, idle + ceiling timers, `.result()`, usable-summary check | unchanged (same stream type), plus bounded cancellation (below) |

`model.api === "pi-virtual"` is the virtual check; `isVirtualModel` is not exported from `@earendil-works/pi-coding-agent` (`dist/index.d.ts:29` exports only `VIRTUAL_MODEL_STATE_ENTRY` and types). The string is a local constant in `src/summarizer.ts`, not a new shared type.

For a virtual model `streamSimple` calls the registered router with `reason: "direct"` and `thinkingLevel: options.reasoning ?? "off"`, drops cross-provider credentials, and streams the physical model. pi-condense never sees the route and writes no router state. The `context` passed is the summarizer's own single user message, as today - no session messages, no state.

### Bounded cancellation

Today the idle and ceiling timers abort the combined signal and `runOnce` then keeps awaiting the stream, relying on the provider to end it. Under `streamSimple` the routing step runs inside `lazyStream` (`pi-ai/dist/api/lazy.js:35-46`), which awaits the router's `route()` without racing it against the signal; a third-party router that ignores `signal` would leave `runOnce` pending forever after both timers fired, blocking fallback and the flush. `runOnce` therefore races every await on the stream (the event iterator and `.result()`) against the combined signal: once the signal is aborted, `runOnce` stops waiting and returns the existing timeout (`transient`, `timedOut: true`) or caller-abort result without waiting for the stream to settle. The abandoned stream is left to finish or not on its own; it has no handle to resources pi-condense owns.

### Thinking mapping

`summarizerThinkingOptions(config)` returns `{}` for `summarizerThinking: "default"` and for `"off"`, and `{ reasoning: level }` for `minimal | low | medium | high | xhigh`. `"off"` is not a `ThinkingLevel` (`pi-ai/dist/providers/model-schema.d.ts:7` - `minimal..max`; `off` exists only on `ModelThinkingLevel`), and passing the string would both fail the typecheck and enter the Anthropic adapter's thinking-enabled branch (`if (!options?.reasoning)` gates the off path). Pi's own compaction does the same `off -> omitted` mapping (`compaction.js:465-466`). `SummarizerThinking` (`src/types.ts:140`) is otherwise a subset of `ThinkingLevel`, so there is no mapping table.

One behavior change rides with this and is a CHANGELOG `Changed` entry: the level now applies on every provider (previously OpenAI-style only, since `reasoningEffort` was never read by the Anthropic adapter). `off` keeps today's behavior (option omitted, provider default; on Anthropic that is `thinkingEnabled: false`).

For a virtual model the router receives the level as `request.thinkingLevel` and may clamp it; an omitted option reaches the router as `"off"` because `streamSimple` substitutes it (`model-runtime.js:500`) - accepted, it matches Pi's compaction call.

### Fallback and resolution - unchanged

`resolveModel`, `runSummarization`, `FallbackController` (`chooseTarget`, `COOLDOWN_MS`, `hasDistinctFallback` by provider+id, enter/recover notices), `summarizeBatch`/`summarizeRange`, diagnostics, and `cost:external` emission do not change. A virtual session model becomes a working fallback target because routing happens inside the call it already receives. The enter notice labels the virtual model by its configured name (`modelLabel(sessionModel)`), not the routed physical model.

### Test seams

The three files that `mock.module("@earendil-works/pi-ai/compat", ...)` (`src/summarizer.test.ts:5`, `src/summarizer-wiring.test.ts:9`, `src/reload-rearm.integration.test.ts:70`) drop that mock and stub `streamSimple` on the fake `ctx.modelRegistry` instead; existing scenarios keep their intent.

## Errors and edge cases

| Case | Behavior |
|---|---|
| Virtual model, router throws / routes to a model without credentials / routes to another virtual model / virtual model not registered | `resolveModel` runs inside `lazyStream`, which ends the stream with an `error` event (`pi-ai/dist/api/lazy.js:35-46`) -> `transient`; controller treats it like any provider failure; flush retains batches. No synchronous throw on this path |
| Virtual router never settles and ignores `signal` | idle or ceiling timer fires, the race against the signal returns `transient` with `timedOut: true`; `runOnce` does not wait for the stream |
| Physical model, key missing | pre-check `ok: false` -> `auth`; one error notice; controller not tripped (contract preserved) |
| Physical model, key present but provider rejects it at request time | stream error -> `transient`, as today |
| Virtual primary and virtual session model with the same provider/id | `hasDistinctFallback` false -> single attempt, no controller; as today |
| Host without `streamSimple` | `TypeError` -> `transient` every batch; README names the minimum version |
| Idle / ceiling timeout during routing | timers wrap the stream iterator, which now includes the lazy routing step; the signal race above guarantees the wait ends |
| Abort signal | passed as `signal`; `streamSimple` forwards it to the router and the physical stream |
| Cost accounting | final `AssistantMessage.usage` is unchanged in shape; `cost:external` unaffected |

## Tests

`bun test src/`.

Unit tests stub `ctx.modelRegistry.streamSimple`; they prove what pi-condense sends and how it classifies what comes back. Routing itself (`reason: "direct"`, the physical choice, untouched router state) is Pi's contract and is exercised end to end by the smoke below, not re-implemented in a fake registry.

- Virtual session model as fallback target: primary returns `transient`, controller enters fallback, `streamSimple` is called with the virtual `Model` object, summary returned, enter notice emitted once. Run for both `summarizeBatch` and `summarizeRange` (both go through `runSummarization`). Covers AC1.
- `summarizerModel: "default"` with a virtual `ctx.model`: single `streamSimple` call, `getApiKeyAndHeaders` not called, the `context` argument holds only the summarizer user message and no state. Explicit virtual `provider/id`: `find` returns it, same assertions. Batch and range. Covers AC2 on the pi-condense side.
- Physical model, `getApiKeyAndHeaders` returns `ok: false`: result `auth`, `streamSimple` not called, controller state unchanged.
- `summarizerThinkingOptions`: `default` -> `{}`; `off` -> `{}`; each of `minimal|low|medium|high|xhigh` -> `{ reasoning: level }`.
- The `Model` passed to `streamSimple` is the resolved model object, not a `baseUrl`-mutated copy.
- Stream `error` event from a virtual model -> `transient`; `summarizeBatch` returns null; the existing flush-retention tests keep passing. Covers AC5.
- Never-settling stream that ignores `signal` (routing that never resolves): with a short idle timeout `runOnce` returns `transient`/`timedOut` without awaiting the stream; same with a caller abort. The existing timeout tests use a cooperative hanging stream and cannot catch this.
- Existing wiring tests (enter, steady-state, both-down, deferred warning, timeouts, abort) and `summarizer-fallback.test.ts` pass unchanged in intent. Covers AC4.
- Typecheck (command in `AGENTS.md`) passes against the 1.3.0 types.
- Smoke, end to end on Pi 1.3.0 (the plan carries the exact script): `pi -e ./index.ts -e <router fixture> --no-extensions` against an isolated `$PI_CODING_AGENT_DIR`, where the router fixture is a small extension in `$TMPDIR` that calls `pi.registerVirtualModel` with a `route()` that returns physical model P2 for `reason: "direct"` and P1 otherwise. Select the virtual model as the session model with `summarizerModel: "default"`, run a prompt that produces tool calls answered by P1, then force a flush. Expect: `context-prune-summary` entries in the session file; the fixture's log shows `reason: "direct"` and P2 for the summary while the last assistant message records P1; no new `pi.virtual-model-state` entry and the session model selection unchanged afterwards. Repeat with the fixture's `route()` throwing for `direct`: flush reports failure and the batches remain unsummarized. Covers AC2's routing half, AC3, and AC5 end to end.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - install section gains the minimum host version (Pi >= 1.3.0) [operations / tunable parameters]; `doc/configuration.md` - `summarizerThinking` row (line 52) states the level applies on every provider and that a virtual router may clamp it, "Choosing a summarizer model" gains one sentence that a virtual model works as `summarizerModel` and as the fallback target [communication contracts]; `CHANGELOG.md` - `## [Unreleased]`: Fixed (virtual models in fallback, `default`, and explicit selection; summarizer no longer hangs on a routing step that ignores abort), Changed (thinking applies on all providers, minimum Pi 1.3.0, dev deps bumped) [non-obvious rationale]
- Derived / memory docs invalidated: none - `PRUNING.md` "Summarizer outage fallback" describes the controller, which does not change, and names no dispatch mechanism; `AGENTS.md` typecheck command is unaffected

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- A feature-detect or legacy `compat.stream` path for Pi hosts older than 1.3.0.
- Any change to the fallback controller: cooldown, probe election, `hasDistinctFallback`, notices.
- Deduplicating primary and fallback when a virtual session model happens to route to the same physical model as the pinned primary (the ticket's AC1 assumes a distinct healthy route).
- Branch-history selection of a physical model (retracted in the ticket).
- Injecting a `streamFn` dependency into the summarizer (Approach 2, rejected: the fake ctx already provides the seam).
- Pattern-matching stream error messages to re-derive `auth` after the pre-check (rejected).
- A fake `ModelRegistry` that re-implements virtual routing in unit tests; routing is Pi's contract and is covered by the smoke.

## Open questions

none
