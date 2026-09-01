# Changelog

Keep-a-Changelog style (`## [X.Y.Z] - <date>`, newest first), matching sibling
pi packages (e.g. [`pi-cohort`](https://github.com/jjuraszek/pi-cohort/blob/main/CHANGELOG.md)).

Published to npm as [`pi-condense`](https://www.npmjs.com/package/pi-condense) (`pi install npm:pi-condense`).
Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which runs the tests and
publishes via OIDC trusted publishing. See `.agents/skills/release/SKILL.md`.

## [2.10.0] - 2026-09-01

- **Custom-message chain anchors ([#13](https://github.com/jjuraszek/pi-condense/issues/13)).** A non-pruner `role: "custom"` message (`customType` not prefixed `context-prune-`) can now open a chain, but only while the chain detector is idle - a non-pruner custom seen mid-chain stays passthrough, not a new anchor. `resolveRange` accepts these as start anchors fail-closed; persisted `custom_message` steers reach chain detection through a shared projection (`src/batch-capture.ts` `projectBranchMessages`); in `agent-message` batching, eligible customs also bound summary groups.
- **Opt-in `frontierGapThresholdTokens` flush trigger.** New absolute-token flush trigger (default `null`, disabled), ORed with `autoBudgetThreshold`/`budgetTurnDelta` (precedence: budget, then delta, then frontier-gap) - fires at `turn_end` once the un-pruned tail past the prune frontier (`frontierGapTokens`) reaches the configured token count, independent of window size. Config-file-only, no `/pruner settings` row; self-throttling via frontier advance on processed flush outcomes (empty attempts advance nothing and rewrite nothing) - after a mid-flush summarizer failure the next gated turn may re-fire while consuming the remaining backlog, so the cadence bound is amortized per new tail growth rather than per-turn-exact. New `"frontier-gap"` value on `context-prune-flush-metrics` entries.

## [2.9.2] - 2026-08-31

- **Context metrics removed from the footer status line.** The ` · think Nk · gap Nk · chain P%` suffix rendered on nearly every non-idle session and crowded the footer for no actionable signal. The metrics stay on `/pruner status` (`--- context ---`) and in the `context-prune-flush-metrics` session entries; the footer is back to prune state, reclaim, and `diag`. The snapshot cache that existed only to feed the widget is gone - both remaining consumers compute on demand.

## [2.9.1] - 2026-08-18

- **Orphan sweep: any foreign message is now a barrier ([#11](https://github.com/jjuraszek/pi-condense/issues/11)).** `sweepOrphanToolResults` only reset its open-call set on `assistant` messages, while pi-ai flushes synthetic tool results at both `assistant` and `user` boundaries (`convertToLlm` maps `custom`/`branchSummary`/`compactionSummary`/`bashExecution` to `user`). A foreign message spliced between a toolCall and its toolResult (observed: a pi-cohort control notice) let the real result through alongside pi-ai's synthetic - a duplicate `tool_use_id` the provider rejects permanently (Anthropic 400, branch bricked). Now any message that is neither `assistant` nor `toolResult` clears the open set, so the interleaved result is swept and pi-ai's repairable synthetic stands alone; already-broken branches un-brick on the next render. Deliberate conservative over-sweep (unknown roles, `excludeFromContext` bashExecution) - no role allowlist. Test helper `expectNoOrphanToolResults` carries the identical rule. Spec: `doc/specs/2026-08-18-gh-11-orphan-sweep-barrier.md` (partially supersedes the 2026-08-12 spec's section C).

## [2.9.0] - 2026-08-14

- **Uncovered chains now compress deterministically instead of stranding forever ([#10](https://github.com/jjuraszek/pi-condense/issues/10)).** Chain compression (Phase 3) required per-batch summary coverage; a closed eligible chain whose span produced no summaries (trivial batches, `skipped-oversized`, fully-deduped spans, capture misses) hit a permanent `no-summary` skip - once the prune frontier passed it, nothing could ever reclaim it. The motivating incident left a 639-call, ~935k-char chain (~62% of a 620k window) live in context indefinitely.
  - **Deterministic zero-LLM fallback.** When coverage is zero, `compressEligible` extracts the chain's middle tool calls positionally (`resolveRange`; protected and already-indexed members excluded), backfills them into the tool-call index, and compresses the chain with a synthetic body - call count, tool histogram, span duration, first/last args excerpts (200-char cap), and `t<N>` refs - carried in `rangeSummaryText` with a new optional `bodySource: "deterministic"` marker. No summarizer traffic, no renderer changes, body render-stable (cache-friendly after the one-time compression).
  - **Mandatory fail-closed recoverability backfill.** New `ToolCallIndexer.backfillChainRecords`: append-before-commit atomicity (in-memory maps mutate only after the `context-prune-index` entry persisted), oversized results spilled via the shared `applySpill` helper (extracted from the eager spill path), refs ride the backfilled entry (`backfilled: true` + `refs`) so they survive restart without a summary message, and backfilled records never seed content-hash dedup canonicals - live or on reconstruction. Any failure preserves the historical skip; the next flush retries and converges by composing from durable records without duplicate index entries.
  - **Edge cases.** Fully-protected chains keep the plain skip (compressing would save zero tokens - every output relocates verbatim). A genuine span mismatch (zero extractable, zero indexed, not fully protected) emits a new `backfill-empty` diagnostic (widget segment is now `diag u/m/o/b`). `/pruner compact` handles all uncovered chains in one pass. Known limitation: an idle session heals a stranded chain on the next working flush or `/pruner compact`, not via `/pruner now` on an empty queue.
  - **Anti-regression cage.** Covered-path entries pinned byte-identical; legacy chain/index entries round-trip unchanged; restart-mid-failure-window convergence, fully-deduped backfill, protected exclusion+verbatim relocation, and multi-chain compact all integration-pinned. All optional fields - pre-upgrade sessions load with today's semantics.
  - **Docs.** `PRUNING.md` deterministic-fallback subsection + diagnostics row, README widget legend + compact note, AGENTS.md entry-table updates. Spec: `doc/specs/2026-08-14-uncovered-chain-deterministic-backfill.md`.

## [2.8.0] - 2026-08-13

- **Both token-budget flush triggers now cap the context window they reason about at 300,000 tokens** (`MAX_BUDGET_WINDOW`, `src/budget.ts`) ([#7](https://github.com/jjuraszek/pi-condense/issues/7)). Previously both scaled purely off the model's advertised window, which made them unreachable as windows grew: on a 1M-window model `autoBudgetThreshold: 0.9` meant 900k tokens - a session ends long before that, so pruning never fired - while the same setting worked on a 200k model. `budgetTurnDelta: 0.1` was worse than late: it meant +100k context growth inside a single turn, which effectively never happens, so the re-arm trigger was dead.
  - `autoBudgetThreshold` now fires at `min(300_000, threshold * contextWindow)` tokens - your percentage of the model's window, or 300k tokens, whichever comes first. The threshold keeps its literal meaning; the cap is only a ceiling.
  - `budgetTurnDelta` applies the same ceiling in the other shape - a 300k ceiling on a single turn's *growth* could never bind - so the fraction is measured against `min(contextWindow, 300_000)`: `0.1` means +30k tokens in one turn on any model at or above 300k (+20k on a 200k model, unchanged).
  - **No new setting, and no behavior change for any model advertising 300k or less, at any setting** - a 256k window at `0.9` still fires at 230.4k. Above 300k flushes happen earlier; nothing ever flushes later than before. Downward control is unaffected: `0.1` on a 1M model still means 100k tokens.
  - `usageFraction` may now exceed `1.0` above the ceiling (600k tokens on a 1M window returns `2.0`) and is deliberately **not** clamped - clamping would saturate the delta trigger and stop it re-arming.
  - Docs updated in step: `README.md`, `doc/configuration.md`, `PRUNING.md`. Spec: `doc/specs/2026-08-13-budget-window-cap.md`.

## [2.7.0] - 2026-08-12

- **Single-chain observability + reload trigger repair ([#6](https://github.com/jjuraszek/pi-condense/issues/6)).** A 5-hour, 256-turn session running one uninterrupted tool chain (no text-only assistant reply ever closed it) accumulated ~195k tokens of raw toolResults while `/pruner status` showed near-zero activity: chain compression (Phase 3) requires *closed* chains by design, and a session reload cleared the in-memory pending queue, leaving the automatic flush trigger stranded even though the branch rescan could recover the work.
  - **Reload rearm.** `session_start` / `session_tree` now probe the branch via the existing capture rescan (no LLM work); when completed unsummarized batches exist past the frontier, a transient `rearmedPending` flag makes the `turn_end` budget/delta gate reachable without a freshly pushed batch - the next threshold crossing flushes automatically. Boolean only: no queue reconstruction, no flush at boot; reload followed by total idleness gets visibility, not silent compaction. Probe failures are reported (`console.error`) and never fail the reload. With the flag unset, `turn_end` behavior is byte-identical to before (regression-pinned).
  - **Context metrics.** New pure module `src/context-metrics.ts` computes what the pruner cannot (yet) reclaim: **open-cycle thinking tokens** (thinking blocks in the trailing open segment), **largest-chain share** (max of largest closed chain vs the open segment, % of total branch chars), and **frontier gap** (summarization-eligible unsummarized toolResults past the frontier, occurrence-keyed and protection-aware). All `chars/4` estimates over the persisted branch, including persisted summary messages.
  - **Surfacing.** `/pruner status` grows a `--- context ---` block (plus `rearmed: yes` when armed); the footer status line grows a self-hiding ` · think Nk · gap Nk · chain P%` suffix (rendered only while the frontier gap is non-zero); `agent_end` shows `prune: recovered pending (reload)` instead of a misleading `0 pending`.
  - **New `context-prune-flush-metrics` session entry.** One per flush attempt - every outcome including `empty` and `error`, single `finally` emit site, delivery-routed writer - recording the trigger (`budget` / `delta` / `message-end` / `manual` / `rearmed`), batch counts, and the pre-flush metrics snapshot. Append-only observability log: never in LLM context, never reconstructed on load; exists so the next incident of this shape is diagnosable post-hoc. `cost:external` payload and `SummarizerStats` semantics unchanged.
  - **Docs.** `PRUNING.md` documents the single-chain limitation (a design property of Phase 3) with `autoBudgetThreshold` / `budgetTurnDelta` guidance for long autonomous runs; README, `doc/configuration.md`, and the AGENTS.md entry table cover the new surfaces. Spec: `doc/specs/2026-08-12-single-chain-observability-trigger-repair.md`.
  - Also hardens the test suite's `@earendil-works/pi-ai/compat` mocks to preserve real module exports (they were silently layout-sensitive under flat/deduped node_modules installs).

## [2.6.0] - 2026-08-12

- **Fix: reused provider tool-call ids could delete a live turn and produce a rejected request ([#8](https://github.com/jjuraszek/pi-condense/issues/8)).** Provider `toolCallId`s (e.g. `bash_23`) are unique only within one response - some providers restart a `${tool}_${n}` counter, so the same bare id recurs across a session denoting different tool calls. `applyChainCompressions` treated the id as session-durable identity: it unioned every persisted chain entry's `droppedToolCallIds` into one session-wide set and dropped any message matching it anywhere in the array, deleting a live assistant turn that happened to reuse a compressed chain's id and orphaning its tool result - rejected outright by Anthropic (`unexpected tool_use_id found in tool_result blocks`) and Kimi K3 (unresolvable tool name), unrecoverable without hand-editing the session JSONL. The same bare ids also mis-keyed the indexer, dedup, `isSummarized`, and batch capture.
  - **Positional chain ranges.** `applyChainCompressions` now resolves each persisted `ChainCompressionEntry` to an index range via `resolveRange` (`src/chain-range-prune.ts`): exactly one `user`-role message at `startUserTimestamp`, exactly one `assistant`-role message at `finalAssistantTimestamp`, `start < end` - any other outcome (including `finalAssistantTimestamp === null`) drops nothing and inserts no synthetic, fail-closed. Drops are role-restricted to `assistant` / `toolResult` / per-batch-summary messages inside the range, so `user`-role messages - including the user-role `<compressed-chain>` synthetic, which keeps re-application idempotent - and third-party `custom_message` entries survive. Per-batch summary suppression stays coverage-based (`toolCallRefs` overlap), not index-membership, because under `batchingMode: "agent-message"` the summary lands after the range. `droppedToolCallIds` is retained only as a diagnostic cross-check against the range's actual contents; the range always wins.
  - **Occurrence-keyed identity.** Records are now keyed `id@resultTimestamp` (`src/occurrence-key.ts`), the discriminant being the `ToolResultMessage`'s own timestamp (not `ToolCallRecord.timestamp`, which is a batch-level timestamp computed inconsistently between the live-capture and session-rescan paths). Persisted shapes gained optional `resultTimestamp` (index records, summary refs), `newResultTimestamp` / `originalResultTimestamp` (dedup aliases), and `droppedOccurrenceKeys` (chain entries) - all optional, so pre-upgrade entries keep bare-id keying and a session spanning the upgrade retains today's behavior for its pre-upgrade half. `isSummarized` is now a strict occurrence-key lookup; the sole sanctioned bare-id fallback is `hasLegacyBareRecord`, true only for a bare id with no occurrence-keyed siblings (a mixed id fails closed on both). Spill sidecars are named from the occurrence key going forward; recovery still reads the persisted `spillPath`, so pre-upgrade blobs keep resolving.
  - **Orphan sweep.** `pruneMessages` now ends with a structural post-condition, `sweepOrphanToolResults` (`src/orphan-sweep.ts`): one forward pass with **per-turn** open-call tracking (each assistant message replaces the open set rather than accumulating into it, so an id used validly early cannot license a later genuine orphan under the same reused id) removes any `toolResult` no surviving assistant opened. Provider-agnostic and structural rather than keyed to any provider's error string; reference-preserving when nothing is swept, so the no-op / prompt-cache-prefix invariant (`doc/specs/2026-08-04-pruner-noop-serialization.md`) holds.
  - **Diagnostics.** New `context-prune-diagnostic` session entry (`{ kind, detail }`, kinds `unresolved-range` / `range-id-mismatch` / `orphan-sweep`) surfaces these degradations without ever entering LLM context - zero tokens, zero cache-prefix change. Deduped per `(kind, dedupKey)`, reset on `session_start` / `session_tree`. The `/pruner` status line grows a self-hiding ` · diag u<N>/m<N>/o<N>` segment (u/m/o map to the three kinds above in that order); each zero counter is omitted and the whole segment disappears when all three are zero.
  - **`context_tree_query` multi-occurrence recovery.** A raw provider id that was reused now returns every matching occurrence (not just one), each labelled `id@timestamp`, chronologically; a legacy record with no `resultTimestamp` is labelled with the bare id plus an explicit `Occurrence: legacy (no resultTimestamp)` line. Short refs (`tN`) are unaffected - still 1:1 and the primary recovery path.
  - **Accepted limitation:** a session that spans the upgrade keeps bare-id keying for everything captured before it landed; only the post-upgrade half of such a session gets occurrence-keyed identity. No migration runs on load. Concretely, within such a session a live tool result whose provider id collides with a pre-upgrade summarized record can still be stub-replaced with that record's stale content (`hasLegacyBareRecord`'s bare-id fallback in `src/pruner.ts` cannot distinguish the two once both denote the same bare id with no occurrence-keyed siblings); new records are unaffected, and the exposure disappears once a session contains no legacy records.

## [2.5.0] - 2026-08-05

- **Removed the main-loop thinking strip (breaking: `contextPrune.thinkingStrip.*` no longer read).** The feature assumed thinking blocks we send are thinking blocks we are billed for. Verified against the live Anthropic API (`count_tokens` and real billed usage agree to the token), the actual rule is: thinking in a *closed* cycle bills 0 input tokens, and thinking in an *open* cycle survives only as an unbroken run starting at the cycle's first assistant turn — any gap discards everything after it. `keepLastTurns` kept the **last** K, so firing it punched a gap at the front and the API dropped all of it: the model received no thinking either way, and the no-gap → gap transition cost a full cache invalidation (measured +33% in a controlled 24-tool-call A/B, $0.6430 → $0.8531, with turn 17 rewriting 63113 tokens at 0% reuse). Across 58 sessions / 1233 open cycles the strip fired 253 times and reached its ~130-turn break-even twice. It was also redundant: chain compression's synthetic block is a `role: "user"` text message, which closes the cycle and frees all prior thinking server-side at zero cache cost. `pruneMessages` drops to three phases (`stub-replace → error-purge → chain-range-prune`); `src/thinking-strip.ts`, `ThinkingStripConfig`, `KEEP_LAST_TURNS_PRESETS`, the two `/pruner` settings entries, and `PruneFrontier.thinkingStripBoundaryTimestamp` are gone. A leftover `thinkingStrip` block in `settings.json` is inert and round-trips untouched (`normalize()` never filters unknown keys); a persisted `context-prune-frontier` entry carrying the old boundary field loads and is ignored. Rationale and measurements: `doc/specs/2026-08-05-remove-thinking-strip.md`.

## [2.4.3] - 2026-08-04

- **Flush-gated, timestamp-keyed thinking strip ([#3](https://github.com/jjuraszek/pi-condense/issues/3)).** Phase 4 (`stripOldThinking`, `src/thinking-strip.ts`) recomputed its keep-window from the *live assistant count on every `context` render*, so each turn the `(count - keepLastTurns)`-th assistant slid forward and its thinking was stripped **deep in history**. pi-ai sets prompt-cache breakpoints only at `tools + system + last message` (verified in `@earendil-works/pi-ai` `api/anthropic-messages.js` `convertMessages` - no in-history breakpoint), so every deep mutation busted the cached suffix - roughly every render inside a tool loop. The strip boundary is now a **flush-computed, persisted assistant-message timestamp** (`thinkingStripBoundaryTimestamp`, added to the `PruneFrontier` snapshot on the existing `context-prune-frontier` entry): fixed between flushes so consecutive renders are byte-stable in their historical prefix (the cache survives a whole tool loop), advancing only on a non-empty flush (piggybacking summarization's own cache bust - zero marginal busts), monotonically clamped (never re-adds thinking to an already-stripped message, even when `keepLastTurns` is increased mid-session), and keyed by timestamp rather than array index so it is robust to phase-3 chain-range middle drops. An absent boundary (pre-feature sessions, pre-first-flush) falls back to the original live-count window verbatim. Additive optional field, fully backward-compatible; **no new config key**, `keepLastTurns` presets unchanged. `PRUNING.md` cache-impact model corrected. Turns the old k-busts-per-render into ~1-per-request.

## [2.4.2] - 2026-08-04

- **No-op renders skip context serialization.** `pruneMessages` (`src/pruner.ts`) computed `sizeMessages` (a full `JSON.stringify` over the entire message array) unconditionally on every `context` render, including no-ops where the result is never read (`index.ts` consumes `beforeChars`/`afterChars` only under `if (result.pruned)`). It now computes both sizes lazily in the pruned branch and returns a `{ beforeChars: 0, afterChars: 0 }` sentinel on a no-op, so a render that prunes nothing does zero `JSON.stringify` over the array. CPU/GC only - zero token cost, no wire or return-shape change. Also corrects a stale fast-path comment in the `context` handler (`index.ts`): index/registry emptiness alone does not imply a no-op, because error-purge and thinking-strip prune independently.
- **Bumped `engines.node` to `>=22.19.0`** to match the host pi runtime (`@earendil-works/pi-coding-agent@0.83.0`); drops advertised support for Node 20/21, which cannot run current pi. Bumped the `@sinclair/typebox` devDependency floor to `^0.34.52` (freshness only; the caret already resolved there).

## [2.4.1] - 2026-07-30

- **Fix 421 Misdirected Request for GitHub Copilot business/enterprise seats.** The summarizer called pi-ai's `stream()` with the static model definition, whose shipped `baseUrl` pins the individual Copilot host (`api.individual.githubcopilot.com`); business/enterprise tokens are rejected there with `421 Misdirected Request`, so any `github-copilot/*` `summarizerModel` failed on those seats. `runOnce` now mirrors the main agent loop (pi's `model-runtime`): it resolves provider auth via `ctx.modelRegistry.getProviderAuth(model.provider)` and, when the resolved auth carries a seat-specific `baseUrl`, rebases the model onto it before streaming. Also bumps `@earendil-works/*` devDependencies to `^0.83.0` (needed for `getProviderAuth` on the extension-facing `ModelRegistry`) and imports `stream` from `@earendil-works/pi-ai/compat` (its export moved off the root in current pi-ai).

## [2.4.0] - 2026-07-09

- **Summarizer call timeout.** Every summarizer stream call is now bounded by an idle timeout (`summarizerIdleTimeoutMs`, default 20s - reset on every stream event, so it never false-aborts a flowing or reasoning generation) and a total-duration ceiling (`summarizerMaxTimeoutMs`, default 180s). Previously a stalled-but-open provider connection hung the whole agent turn indefinitely, since `runOnce` had no time budget and the automatic flush paths pass no abort signal. A timeout classifies as transient and feeds the existing outage-fallback retry (one bounded session-model attempt when a distinct `summarizerModel` is set), then surfaces a `warning` notice. Both timers are `0`-disablable and exposed in `/pruner settings` and `/pruner status`.

## [2.3.0] - 2026-07-06

- **Recovery grace window for `context_tree_query` output.** The pruner used to re-stub its own recovery output at the next turn boundary, forcing a retrieve -> re-stub -> re-query loop the agent experiences as "fighting the pruner" (observed in a real session: a recovered tool dump was re-summarized on the very next flush, so the agent had to keep re-querying the same ref). A new `recoveryGraceTurns` setting (default `3`, `0` disables) keeps a recovered output verbatim for that many user-turn-groups before reverting to the stub. Enforced at **render time** in two places - Phase 1 stub-replace (`src/pruner.ts`) and chain-compression eligibility (`src/chain-compressor.ts`, which defers compressing any chain whose span still holds an in-grace recovery id) - never at capture, so the frontier, dedup, spill, and live `turn_end` paths are unchanged. The window is computed positionally from the message stream (no new `ToolCallRecord` field). Default `3` covers ~81% of same-ref re-queries observed in the local session corpus; the accepted trade-off is that a reference past the window is re-stubbed and may be re-queried, keeping context regrowth bounded rather than permanent. Tunable via `/pruner recovery-grace [n]` and the `/pruner settings` overlay. See [PRUNING.md § What Pruning Does](PRUNING.md#what-pruning-does).

## [2.2.1] - 2026-07-06

- **Fix probe starvation in the summarizer outage fallback.** `FallbackController.onFallbackOnlyFail` reset the re-probe cooldown on every steady-state fallback failure, so a fallback (session) model that failed at least once per 10-minute cooldown perpetually pushed out the primary re-probe - a recovered `summarizerModel` was never re-tested and summarization stayed on the pricier session model indefinitely (the exact stall the feature exists to kill, in the fallback direction). The method is now a no-op on `lastProbeAt`: the primary re-probe fires on schedule regardless of fallback failures. In-memory only; no wire/config change.

## [2.2.0] - 2026-07-06

- **Summarizer outage fallback to the session model.** Per-model provider outages (e.g. a cheap `summarizerModel` like Haiku degraded while the session's main model stays healthy) previously stalled pruning for the whole outage - `runSummarization` returned null and the batch retried the same dead model every flush, growing context unbounded. A new sticky in-memory `FallbackController` (`src/summarizer-fallback.ts`) now routes summarization to `ctx.model` on a **transient** failure of the configured model, retrying the failed call once on the session model. Fallback is sticky: while engaged, all calls use the session model until a single probe batch re-tests the configured model after a 10-minute cooldown, then auto-recovers. Trigger is transient-only - auth (pre-flight key failure), unusable (empty/truncated), and abort never trip it. A one-time `warning` fires on enter and an `info` on recovery via `ctx.ui.notify` (UI only, never injected into LLM context). No config key: the target is always `ctx.model`, and the controller is inert when no distinct fallback model exists (`summarizerModel: default` or the resolved model equals `ctx.model`), preserving today's single-attempt behavior byte-for-byte. State is in-memory only (reset on `session_start`, no `context-prune-*` entry).

## [2.1.2] - 2026-07-05

Branding, funding, and gallery preview. No behavior change.

### Added

- **Logo + pi.dev gallery preview.** Repo-root `pi-condense.png` (640x640), shown in the README and wired as `pi.image`.
- **Buy Me a Coffee funding.** `funding` in `package.json`, `.github/FUNDING.yml`, and a README badge.

### Changed

- Sharpened `description`; added `context-pruning`, `llm`, `prompt-caching` keywords.
- README reframed product-first (credit to `championswimmer/pi-context-prune` kept as attribution); fixed a stale `pi-superpowers` -> `pi-gauntlet` reference in a spec doc.

## [2.1.1] - 2026-07-04

- **`release.yml` posts GitHub Release notes.** A new `release-notes` job (`needs: publish`, `contents: write`) extracts the CHANGELOG section matching the pushed tag with `awk` (skipping `## [Unreleased]`) and publishes it as the GitHub Release body via `gh release create` (falling back to `gh release edit`). No LLM or API key; only `github.token`.

## [2.1.0] - 2026-07-04

- **Per-bullet recovery refs in prune summaries** (closes #2). Each per-tool block in a summary now carries its own inline `` `tN` `` ref, so the model recovers a specific tool's raw output in one hop instead of guessing which flat-footer ref maps to which bullet. The serializer labels each tool block `[[N:toolname]]` (`src/batch-capture.ts`), the summarizer prompt tells the model to copy that label onto its first bullet (`src/summarizer.ts`), and `substituteInlineRefs` (`src/summary-refs.ts`) validates the echoed tool name against the tool at position N before rewriting to `` `tN` ``. The flat footer is retained unchanged as the always-correct fallback. Deterministic number->shortId map over the shared post-dedup `batch.toolCalls` order; the tool-name tag downgrades a confident wrong-ref (skip-induced renumber) to footer-only, and mismatched / out-of-range / wrapped / mid-line labels are stripped (fence-aware leak guard) so no raw `[[N:name]]` token ever leaks into context. No new tool, config key, or index.

## [2.0.1] - 2026-07-03

- **Prune summaries are now hidden from Pi's main window** (`display: false` at both injection sites in `index.ts`). They stay in LLM context and session history (recoverable via `context_tree_query`) but no longer print the full markdown block into the TUI. Mirrors upstream `pi-context-prune` `2fd6127`.
- **Sharpened the summarizer prompt** (`src/summarizer.ts`): the key-outcome bullet now requires copying file paths, identifiers, signatures, and error strings *verbatim* (never reworded), and the summarizer skips tool calls that succeeded with nothing reusable to record. Scoped to short tokens - values/full output stay summarized, so the ~8x median compression and the oversized guard are unaffected.
- **`context_tree_query` description now shows a literal call example** (`{ toolCallIds: ["t12", "t3"] }`) and consolidates the two near-duplicate parameter descriptions into one that marks the field required. Reduces the empty-first-call retry seen in real sessions. No schema or behavior change.

## [2.0.0] - 2026-07-02

- **Renamed the package `pi-context-prune` -> `pi-condense`** and switched distribution from git-tag pins to npm. Install with `pi install npm:pi-condense` (was `git:github.com/jjuraszek/pi-context-prune@vX.Y.Z`). Migrate pinned `settings.json` entries; `release.sh sync-presets` reports stale pins.
- **Added npm release machinery:** `.github/workflows/release.yml` (tag-triggered, OIDC + provenance, `tag == package.json` gate) and `test.yml` (bun, Ubuntu + Windows matrix). Ported `release.sh` to the shared sibling skeleton (`propose` / `patch|minor|major` / `current` / `verify` / `sync-presets`), replacing the old tag-pin `release.mjs`.
- **Added** `LICENSE` (MIT), `files` allowlist, `engines`, and `author` to `package.json`; removed dead `pi.skills` / `pi.prompts` manifest entries (those directories never existed).
- **Renamed** the cost-event producer id `EXTERNAL_COST_SOURCE` `"pi-context-prune"` -> `"pi-condense"`. Aggregators keyed on the old `source` string see it as a new producer.

## [1.0.0] - 2026-05-31

- **Removed three `pruneOn` modes**, leaving `agent-message` (default) and `on-demand`:
  - `every-turn` - debugging-only trigger with the worst prompt-cache churn.
  - `on-context-tag` - depended on the external `ttttmr/pi-context` extension and overlapped its `context_compact`.
  - `agentic-auto` - the scaffolded DCP-style model-driven `context_prune` tool was never wired to range compression (see `PRUNING.md`, Future Work).
- **Removed** the `context_prune` tool, the agentic-auto system prompt, the `<pruner-note>` unpruned-count reminder, and the `remindUnprunedCount` setting. Deleted `src/reminder.ts`, `src/context-prune-tool.ts`, `src/progress-text.ts`.
- **Migration:** none required. Configs pinned to a removed mode fall back to `agent-message` via `isPruneOn()`. A stale `remindUnprunedCount` key in `settings.json` is ignored.

## [0.11.1] - 2026-05-28

- **Release flow:** `release.sh` now rewrites every `~/.pi/agent*/settings.json` pin of `git:github.com/jjuraszek/pi-context-prune@<ref>` to the new `@vX.Y.Z` automatically after pushing the tag. Opt out with `--no-update-pins`. Aligns this fork's release workflow with sibling pi-* packages.
- **Docs:** `README.md` install section leads with the jjuraszek tag-pin (was upstream npm/sha references). `AGENTS.md` release blurb updated to reflect tag pins + automatic settings rewrite. `.agents/skills/release/SKILL.md` documents the new flow + flags. Adds this `CHANGELOG.md` for parity with sibling pi-* packages.

## [0.11.0] - 2026-05-28

- **Pre-flush pipeline:** content-hash dedup (re-reads of identical `(toolName, content)` pairs alias the original instead of going through the LLM), trivial-batch skip (`minBatchChars`), protected tools allowlist, stub-replace rather than delete. See `PRUNING.md`, Pre-flush Pipeline & Safeguards.
- **Settings:** moved to `<agent-dir>/settings.json#contextPrune` namespace (was a separate file). Honors `$PI_CODING_AGENT_DIR`.

## [0.10.0] - 2026-05-11

- `quietOversizedSkips` setting to suppress `skipped-oversized` notifications.
- Demote oversized-skip notification severity to info.
- Use short refs in pruned summaries (e.g. `t1`, `t2` rather than full toolCallIds) so the model can pass them back through `context_tree_query` more reliably.

## [0.9.x] - 2026-05-05 to 2026-05-11

- `0.9.3`: spinner animation fix for `/pruner now`.
- `0.9.2`: replace footer progress with aboveEditor widget during `/pruner now`.
- `0.9.1`: allow `ESC` to cancel `context_prune` tool call.
- `0.9.0`: agentic-auto mode (`pruneOn: "agentic-auto"`), `context_prune` tool surfaced to the LLM, `remindUnprunedCount` setting.

## [0.8.x] - 2026-05-04 to 2026-05-05

- `0.8.1`: bug fixes around session-start index rebuild.
- `0.8.0`: `agent-message` trigger mode + batching, footer status widget.

## [0.7.0] - 2026-05-04

- `on-context-tag` trigger mode (integrates with `pi-context` `context_checkpoint`).

## [0.6.x] - 2026-05-02

- Tree browser (`/pruner tree`) + summary overlay (`Ctrl-O`).
- `dedupByContentHash` cross-flush dedup.

## [0.5.0] - 2026-05-01

- Cumulative summarizer token/cost stats (`/pruner stats`).

## [0.4.0] - 2026-05-01

- Configurable summarizer model + thinking level (`/pruner model`, `/pruner thinking`).

## Earlier (v0.1.x - v0.3.x)

Initial extension scaffolding, `context_tree_query` tool, base summarization loop, session-JSONL index persistence. See `git log` for granular history.
