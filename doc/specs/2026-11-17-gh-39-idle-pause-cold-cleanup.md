# Idle cleanup: the first prompt after a long pause compresses every finished turn before the context is re-cached

**Goal:** When a user prompt is submitted more than an idle threshold (default 180 minutes) after the last cache-refreshing request, pi-condense compresses every closed chain with the existing chain compression (no summary fusing) and replaces the superseded reads waiting inside those chains before that run's first request, so the cold re-cache pays for a smaller context; user messages, final answers, batch summaries, and protected outputs stay word for word.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** [jjuraszek/pi-condense#39](https://github.com/jjuraszek/pi-condense/issues/39)

Extends, does not supersede: `doc/specs/2026-09-07-protected-path-supersede.md` (its five cold-cache events and floor rule stay live; this spec adds a sixth moment) and the rolling-window rule in `PRUNING.md` "Rolling window" (the idle cleanup is a second bypass beside `/pruner compact`). No banner is written.

## Problem

After an overnight or hours-long pause the provider's prompt cache has expired, so the first request re-sends and re-caches the whole context. pi-condense sends that context as it stood before the pause, including the most recent closed chains it holds raw until three newer chains close (`chainCompression.rollingWindow`, default 3). The user pays to cache that text at the return and again when the later compression rewrites the prefix.

The requester's hard constraint: no regression in skill following or in pi-gauntlet process state. Requester's words: "gauntlet regression is not acceptable"; "make sure we won't regress and skill following with that and current state of gauntlet process"; "first message from human after long period is scenario we are addressing here"; "just make sure that eval is targeted and not full sweep".

Framing: pivoted to one idle threshold after which the first request compresses closed chains with the existing chain compression and runs the superseded-read cleanup - the ticket's original lifetime-timed stub cleanup measured at about $0.30-$1.60 a month on the requester's corpus. Ticket #39 was repaired through `/skill:shape-ticket` on 2026-11-17 to describe the pivot; its 13 rows below are the contract.

### Measurement (requester's private sessions, 2026-10-19 to 2026-11-17)

Corpus: 658 top-level session files of three checkouts (consumer repo A 326, consumer repo B 170, pi-gauntlet 162), active branch only, $19.9k recorded spend. A "return" is a request whose gap since the previous request or `cache_warm` usage entry on the branch is at least 60 minutes. Each return point was rebuilt with this repo's code (`pruneMessages`, `detectChains`, `selectEligible`, indexer reconstruction) under the requester's live settings. Token figures are estimates at 3.5 chars/token (estimated/billed median 0.86).

| Claim | Lookup | Result |
|---|---|---|
| Retention tier in force | `usage.cacheWrite1h / usage.cacheWrite` per Anthropic-family request | Held: 1.00, the 1-hour tier. |
| Long pauses happen and cost | gaps on active branches, `usage.cost.cacheWrite` at the return | Held: 191 returns at 60 min+ ($559, 2.8% of spend); 91 at 3 h+ ($300, 1.5%; A 56, B 14, pi-gauntlet 21); median prompt at a 3 h+ return 137k tokens. |
| Text waits for the superseded-read cleanup at a pause | render with simulated floor history vs `floor = 0` | Corrected: 16k tokens across the 91 returns (about $0.30), 95k across the 191 (about $1.60). Existing floors already activate about 90% of superseded copies. |
| A declared cache lifetime is available to time the pause | pi-ai model catalog and the requester's `models.json`; extension API `.d.ts` | Corrected: only Anthropic-family models declare one (77% of spend); GitHub Copilot GPT models declare none. An extension sees `ctx.model` and `PI_CACHE_RETENTION` but no request's own `cacheRetention`. |
| When the message cache is cold | share of returns (prompt 80k+ tokens, same model) reading more than the system/tool prefix from cache | Held for a fixed threshold: 0 of 118 Anthropic-family returns at 60 min+ and 0 of 62 Copilot returns at 45 min+ were warm. |
| Gain of compressing every closed chain at the return, summaries kept as written | simulated chain entries with no fused text, cold render | 3 h+: 5.15M tokens, median 23% of the prompt, $89 at the return; 60 min+: 9.76M tokens, $165. Upper bounds on later savings at 3 h+: $149 cache reads, $411 later compression rewrites. About 3% of spend at 3 h, 5% at 60 min. |
| What that compression removes | category delta at the 91 returns | assistant thinking 58%, tool-call arguments 23%, raw never-summarized results 15%, stubs 4%. Batch-summary text moves into chain bodies unchanged. |
| What remains | category shares after compression | protected outputs 55%, system 17%, chain summaries 12%, injected skill text 5%, final assistant text 5%. Protected content is the floor. |
| How lossy fusing is | fused vs concatenated summary length, 307 fused chain entries | p50 0.35, 0.14 when 12+ summaries are fused. Fusing is excluded from the idle cleanup for that reason. |
| A 3 h+ return happens inside a running turn | message preceding the first request after each pause | 0 of 91 at 3 h+ (all followed a user message); at 60 min+, 13 of 191 did not follow a user message. |
| pi-gauntlet keeps its state outside the prompt | pi-gauntlet at `09c9f4e1`: `extensions/phase-tracker.ts:112-125`, `skills/brainstorming/SKILL.md:177` | Held: tracker state is read from session entries; spec, plan, and ledger are files; skill resources are loaded with `read` so path protection applies. |
| The behavioral eval can show a gauntlet regression | `eval/scenarios/*.ts`, `eval/config.ts`, `eval/README.md` | Missing: the seven cases hold no skill file, no tracker result, no protected output, and no return after a pause. The private-session replay scores summarizer inputs only. |
| Scale reference | requests under 5 min after the previous one with under 20% cache read | Full rewrites with no pause cost $4.6k (23% of spend). Outside this spec. |

Not checkable, carried as assumptions or Open questions: whether an overnight return continued the same process or reopened the session (session files carry no start marker; the design reads the pause from session timestamps, so both are covered); providers absent from the corpus; natural experiments with a smaller rolling window (unreliable in the scratch extractor).

### Code facts the design rests on

| Fact | Source |
|---|---|
| `before_agent_start` is awaited before a run's first request and runs the flush step there: it awaits a settled flush, or flushes pending work. A no-UI session whose only work is re-armed returns without flushing, and the result of `flushPending` is not inspected | `index.ts:1082-1093` |
| `before_agent_start` fires for a submitted prompt, an RPC prompt, and `pi.sendUserMessage()` (`messageType: "user"`), and for `pi.sendMessage(..., { triggerTurn: true })` while idle (`messageType: "custom"`); the event carries no input source. The `input` event carries `source: "interactive" \| "rpc" \| "extension"`; `pi.sendUserMessage()` submits with `"extension"`, and a prompt with no stated source is `"interactive"` | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:748-762,928-937`; `dist/core/agent-session.js:1736,2038` |
| The `context` handler only renders (`pruneMessages`) and writes nothing | `index.ts:1127-1166` |
| `compactChains` (behind `/pruner compact`) detects chains on the projected branch, calls `compressEligible(chains, 0, ...)`, honors recovery grace, lowers the supersede floor, and always passes `fuseRange: makeFuseRange(ctx)` | `index.ts:1181-1216` |
| `fuseRange` is optional in `compressEligible`; without it the chain body is the per-batch summaries concatenated, and a chain with no summary takes the deterministic zero-LLM body (its results are backfilled into the index). A chain with at least one summary gets no backfill: a result in it that was never summarized leaves the request with no summary and no recovery ref | `src/chain-compressor.ts`; `index.ts:226-229` |
| The renderer substitutes resolvable `{bN}` block references inside a chain body, the concatenated one included, so an unfused body is not literal by itself | `src/chain-range-prune.ts:42-50`; `src/pruner.ts:175-193` |
| `compressEligible` appends and registers one `context-prune-chain` entry per chain as it goes, with no rollback; `compactChains` lowers the supersede floor to the earliest compressed chain's start only after the writes | `src/chain-compressor.ts:311-313`; `index.ts:1210` |
| `detectChains` closes a chain on any assistant message without tool calls; it does not read `stopReason` | `src/chain-detector.ts` |
| Protected calls are filtered out of capture and never indexed; a chain whose tool calls are all protected is not compressed | `index.ts:192,936`; `src/batch-capture.ts`; `src/chain-compressor.ts:230` |
| A batch whose raw result text totals less than `minBatchChars` (default 2000) is never summarized or indexed; its results stay raw until chain compression | `index.ts:374-392`; `PRUNING.md` "Trivial-batch skip (minBatchChars)" |
| A compressed chain keeps the opening user message, the final text-only assistant message, and every protected output as `<protected-output>`. Protected output is carried as its extracted text: text blocks as written, an image block as an `[image returned: <mimeType> sha256:<8hex>]` marker | `src/chain-range-prune.ts:42-67`; `src/batch-capture.ts:64-71` (`extractToolResultText`); `PRUNING.md` "Protected tools & paths" |
| An older protected read already superseded relocates as its stub because the supersede phase (1b, `applySupersede`) runs before the chain render (phase 3, `applyChainCompressions`) | `src/pruner.ts:150-157,168-194` |
| Cold-moment handlers set `supersede.floor = 0` | `index.ts:832,870,883,886,889` |
| A pending floor is consumed once, over every candidate in the whole message array: `floor === 0` activates all of them, the turn in progress included | `src/supersede.ts:128-145`; `src/pruner.ts:150-157` |
| The last cache-refreshing request is on the branch: assistant message entries and `UsageEntry` with `kind: "cache_warm"` | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:36-45` |
| The newest cache-refresh time is the entry's ISO `timestamp` string (`SessionEntryBase.timestamp`). An assistant message also carries a numeric `message.timestamp`; a `cache_warm` usage entry has only the entry timestamp | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:36-45` |
| `getPromptCacheTtlMs(model, options)` with `options` undefined picks the `long` tier only when `PI_CACHE_RETENTION` is exactly `long`, and the `short` tier for every other value, unset and `none` included; it returns `model.promptCache[tier] * 1000`, or `undefined` when the model declares no lifetime for that tier. Retention `none` yields `undefined` only through `options.cacheRetention`, which an extension cannot see. Every declaring catalog model is `{ short: 300, long: 3600 }` seconds | `node_modules/@earendil-works/pi-ai/dist/cache-warming.js:26-33`; `cache-warming.d.ts:39` |
| No `chainCompression` field is validated on load today | `src/config.ts` |
| `DiagnosticKind` is a closed four-member union backing `DiagnosticSink.counters`, the footer segment `diag u<N>/m<N>/o<N>/b<N>`, and the `PRUNING.md` "Diagnostics" table and session-entry row | `src/types.ts:99`; `src/diagnostics.ts:12`; `src/commands.ts:63-76`; `PRUNING.md:304,1203-1214` |
| `/pruner compact` reaches `compactChains` as a function injected into `src/commands.ts`; whether it fuses is decided in `index.ts` | `src/commands.ts:476,1042`; `index.ts:1181-1216` |
| Eval seeds are stamped from `Date.UTC(2026, 0, 1)`; the probe is the only prompt that starts an agent run | `eval/scenario.ts:19-37`; `eval/session.ts:86,102` |
| Adding a file to `eval/scenarios/` or a key to `PIPELINE_SETTINGS` changes the comparison key and blocks comparison against both committed baselines | `eval/run.ts:131-137`; `eval/config.ts` (`settingsHash`, `corpusHash`) |
| Seed timestamps reach the model only through the deterministic body's `Span:` line. In the seven-case corpus every seeded id is summarized before the probe, so no seven-case request carries that line; the idle suite seeds protected and never-summarized results, so this holds for the seven cases only | `src/chain-compressor.ts:174`; `eval/session.ts:92-95` |
| The eval session proofs require every seeded id to be in the index after the flush, and in the first subject request every raw seeded result to be absent and every seeded id to have its own summary-stub `toolResult` message. Chain compression removes the `toolResult` messages inside a compressed range | `eval/session.ts:94-95,118`; `src/chain-range-prune.ts` |
| The eval subject's only active tool is `context_tree_query`; a scenario can carry both a `mechanical.contains` literal list and a `judged` oracle, and the mechanical gate runs before the judge | `eval/session.ts:83,114`; `eval/scenario.ts:15-16`; `eval/README.md:41-45` |

## Acceptance criteria

Ticket #39, Acceptance Criteria, rows verbatim:

- [ ] With the idle threshold at its default of 3 hours: on the first request after a pause longer than the threshold, every finished turn that used tools is sent compressed, including the most recent ones that are otherwise held in full until three newer turns finish. The existing exceptions still apply: a turn with no tool work, a turn whose original output was recovered within the recovery grace window, a turn holding only protected output, and a turn whose place in the context cannot be resolved stay as they are.
  in-scope
- [ ] In that request, an older read of a protected file that a later read of the same file fully covers, and that was waiting to be replaced by its one-line placeholder, is replaced.
  in-scope
- [ ] In that request, each turn the idle cleanup compressed carries its user message, its final answer text, every batch summary it held, and every protected output it held other than a read replaced under the previous row, each word for word; no summary is fused or rewritten.
  in-scope
- [ ] In that request, the turn in progress is sent exactly as it would be without the idle cleanup.
  in-scope
- [ ] After a pause shorter than the threshold, the request is identical to the one sent without the idle cleanup.
  in-scope
- [ ] A pause is measured from the last request that refreshed the cache, real or warming: when pi's cache warmer last refreshed the cache less than the threshold before the request, the request is identical to the one sent without the idle cleanup.
  in-scope
- [ ] A session closed and reopened more than the threshold after its last request gets the idle cleanup on its first request.
  in-scope
- [ ] When the active model declares a cache lifetime for the retention tier in force that is longer than the threshold, that lifetime replaces the threshold: a pause shorter than it changes nothing, and a pause longer than it gets the idle cleanup.
  in-scope
- [ ] When the active model declares no cache lifetime, the threshold alone decides whether the idle cleanup runs.
  in-scope
- [ ] With the threshold set to another duration, the rows above hold at that duration.
  in-scope
- [ ] Skill following is not regressed: a session following a pi-gauntlet skill's multi-step procedure ends a turn on an approval question with lettered options and sits idle past the threshold; the user replies with one letter. Scored on whether the model's next action is the step the skill prescribes for that letter, the session continued with the idle cleanup passes as often as the same session continued without it, under the behavioral eval's documented comparison rule (three runs per case; a pass-count drop that repeats on one re-run is a regression).
  in-scope
- [ ] Workflow state is not regressed: a session with pi-gauntlet plan and phase progress recorded sits idle past the threshold and is asked to continue. Scored on whether the model resumes at the task the latest plan progress marks as in progress, the session continued with the idle cleanup passes as often as the same session continued without it, under the same comparison rule.
  in-scope
- [ ] `PRUNING.md` describes the idle cleanup beside the other cold-cache moments: the threshold, what restarts the pause clock, and what the cleanup keeps word for word.
  in-scope

## Legs

### Leg: jjuraszek/pi-condense
branch: gh-39-idle-pause-cold-cleanup
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `bun test src/`; `npm run test:eval`; typecheck `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove, never committed); the four paid or external actions in Design "Paid and external actions", once at finish; the plan is `git rm`-ed before the branch finishes (`.pi/gauntlet-overrides.md`, "Plan retention")
Rules: AGENTS.md
Rules: README.md
Rules: PRUNING.md
Rules: eval/README.md
Rules: .agents/skills/release/SKILL.md
Rules: CHANGELOG.md
Rules: .pi/gauntlet-overrides.md
Rules: AGENTS.core.md
scope: none
design: owns every path in Design; the observable outcomes are the thirteen acceptance rows above.

## Design

### Readings of ticket rows

- "Finished turn" is a closed chain as `detectChains` reports it. `detectChains` closes a chain on any assistant message without tool calls, whatever its `stopReason`, so a run that ended in an error or an abort while writing text is a finished turn and the cleanup compresses it. Only a chain left structurally open - its last assistant message still holds tool calls - gets the in-progress exemption.
- "Turn in progress" is defined by ownership, not position: every message that follows the last closed chain's opening user message and belongs to no closed chain - a structurally open chain, and the newly submitted user message. A batch-summary message that sits after the last closed chain's final assistant message but summarizes that chain's calls belongs to the chain: compression removes the message and carries its text in the chain body, so it is checked under row 3, not row 4. The design, the row 4 integration test, and the replay use this one definition.
- Row 4 takes precedence over row 2: the cleanup replaces a waiting superseded read only when the older read sits inside a finished turn. An older read inside the turn in progress stays as it would be without the cleanup.
- "First request after a pause" is the first request of the run a human-submitted prompt starts: interactive or RPC input. A run an extension starts (`pi.sendUserMessage()`, or a custom message with `triggerTurn`) gets no cleanup. The pause is checked once per prompt, at submission. A pause inside a running run (one tool call or dispatch outlasting the threshold) gets no cleanup.
- "Word for word" (row 3) for a batch summary is its stored text: a `{bN}` block reference inside it stays as written. For a protected output it is the extracted text (`extractToolResultText`): text blocks as written and an image block as its `[image returned: <mimeType> sha256:<8hex>]` marker, which is how a compressed chain already carries protected output. The original image block is not kept in the request.
- "Passes as often" (rows 11 and 12): within one eval run, the paused twin's pass count out of three is not lower than its fresh twin's. A lower count is a regression candidate; the same command is re-run once and two consecutive drops for the same pair are a regression. The comparison is evidence only when the fresh twin passes every run: a fresh twin that fails a run shows the fixture is not reliably solvable, and the pair is inconclusive - neither a pass nor a regression.
- "A pi-gauntlet skill" (row 11) and "pi-gauntlet plan and phase progress" (row 12) are synthetic fixtures in pi-gauntlet's shapes: a skill file with a numbered procedure and a lettered approval question whose letters map to different next steps, read through `read` at a path matching `**/skills/**/*.md`; `plan_tracker` and `phase_tracker` results in those tools' output format. No real skill text or private session content enters the repo.
- "The model's next action" (row 11) and "resumes at the task" (row 12) are read from the reply text: the eval subject's only tool is `context_tree_query`. Each fixture names the scored step or task with a distinct literal token that the reply must contain before the judge scores it.
- Rows 11 and 12 are scored under the default tracker configuration (`protectedTools: []`), where tracker results are ordinary tool output that is summarized, left raw below `minBatchChars`, and then compressed. The requester's own configuration protects both trackers; it is covered by the offline relocation test and the real-session replay, which make no model call. No paid result is evidence for the protected-tracker configuration.

- **"Read of a protected file" (rows 2 and 3)** is the existing supersede candidate: any protected call whose arguments carry a string `path` and that `findSuperseded` (`src/supersede.ts`) lists as fully covered by a later call on the same path. `plan_tracker` refreshes of one ledger path and a protected `edit` covered by a later full read are candidates exactly as at the five cold events; the idle cleanup narrows only where it applies (finished turns), never which calls qualify. The replay accepts the superseded placeholder for every such candidate, not only for the `read` tool.
- **"Every batch summary it held" (row 3)** includes a summary the flush wrote late, positioned inside the range of the turn it summarizes (an interrupted turn): a `literalSummary` chain entry keeps per-batch summary messages inside its range instead of dropping them by position. Entries without the field keep the positional drop.
- **Never-summarized result text** retained by the idle cleanup excludes two kinds of result that already carry a pointer to their content: a dedup alias (its original is retained or summarized under its own call) and a capture-spilled result (its stub names the spill file). Both keep the pointer they had before the cleanup and are not restored as raw text.

### Pause clock

Add `src/idle-pause.ts`, a pure module with no pi imports beyond types:

- `lastCacheRefreshMs(branch)`: the newest timestamp among the branch's assistant message entries and `usage` entries with `kind === "cache_warm"`; `undefined` when the branch has neither. Both kinds are read the same way: `Date.parse(entry.timestamp)`, the ISO `SessionEntry.timestamp`, as epoch milliseconds. `message.timestamp` is not read; a `cache_warm` entry has none. Every assistant message counts, including one that ended in error or abort: counting it can only postpone the cleanup.
- `idleCleanupDue({ branch, now, thresholdMinutes, declaredLifetimeMs })`: `false` when `lastCacheRefreshMs` is `undefined` or later than `now`; otherwise `now - last > max(thresholdMinutes * 60_000, declaredLifetimeMs ?? 0)`.

The clock reads only session entries, so a reopened session needs no new persisted state (row 7).

### Setting

Add `idleCleanupMinutes: number` to `ChainCompressionConfig` (`src/types.ts`), default `180` in `DEFAULT_CONFIG.chainCompression`. `src/config.ts` normalizes it on load: a finite number above zero is used as given; anything else loads as `180`. The `/pruner` settings overlay (`src/commands.ts`) gains one item beside `rollingWindow` with presets `60`, `180`, `480`, `1440`. There is no separate off value: the cleanup is off when `enabled` is false, `pruneOn` is `on-demand`, or `chainCompression.enabled` is false.

### Trigger

Add an `input` handler (`index.ts`) that records the event's `source`; `before_agent_start` carries only `messageType`. Restructure the `before_agent_start` handler so the existing flush logic becomes a step whose every exit falls through to one idle check, with no `hasUI` condition on the check:

1. Run the existing flush step unchanged, for every run whatever started it (await the settled flush; or cancel it and flush pending or re-armed work under today's conditions). Its result is not inspected, as today.
2. Return unless the run is a human submission: `event.messageType === "user"` and the source recorded from the most recent `input` event is `"interactive"` or `"rpc"`. A run started by `pi.sendMessage(..., { triggerTurn: true })` (`messageType: "custom"`) or by `pi.sendUserMessage()` (source `"extension"`) gets the flush step and no idle cleanup; `messageType === "user"` alone does not tell an extension-sent message from a human one.
3. Return when `!flushesAutomatically()`, when `chainCompression.enabled` is false, or when a flush is still in flight (`isFlushing`); a flush in flight at submission skips the cleanup for that prompt.
4. Compute `idleCleanupDue` with `ctx.sessionManager.getBranch()`, `Date.now()`, `chainCompression.idleCleanupMinutes`, and `getPromptCacheTtlMs(ctx.model, undefined)` when `ctx.model` is set (`undefined` otherwise). Return when it is `false`. With `options` undefined the helper reads the tier from the environment: `long` when `PI_CACHE_RETENTION` is exactly `long`, `short` otherwise.
5. Activate the waiting superseded reads of finished turns (row 2), whether or not any chain is compressed: run `findSuperseded` over the projected branch and add to `supersede.activated` every candidate whose older read sits inside a closed chain. A candidate whose older read sits in the turn in progress is not touched, and `supersede.floor` is left as found, so a floor already pending from a cold event or from the flush step is consumed by the next render exactly as it would be without the cleanup. The five existing cold-event handlers keep setting `supersede.floor = 0` for the whole branch.
6. Call `compactChains(ctx, { idle: true })`.

Add an options parameter to `compactChains`: `{ idle?: boolean }`, default `false`. `/pruner compact` keeps calling it with the default and keeps fusing, rendering, and lowering the floor as today. With `idle: true` it differs in three ways:

- It passes `fuseRange: undefined`, so no summary is fused.
- Every `context-prune-chain` entry it writes carries `literalSummary: true`, a new optional field on `ChainCompressionEntry` (`src/types.ts`) that `compressEligible` stamps on request. The renderer (`applyChainCompressions` / `buildSyntheticChainMessage`, `src/chain-range-prune.ts`) emits the body of such an entry without `substituteBlockRefs`, so a `{bN}` reference inside a batch summary stays as written. The field is persisted with the entry and survives indexer reconstruction, so a reload renders the same bytes. An entry without the field - rolling window, `/pruner compact`, or written before this change - renders as today, block references substituted.
- It skips the `lowerFloor` call after the writes. Step 5 has already activated every candidate inside a closed chain, and lowering the floor to a compressed chain's start would also activate reads in the turn in progress.

For idle entries only, `compressEligible` also retains each unprotected result occurrence that has no covering per-batch summary as extracted text, using the existing protected-output relocation path and persisted `protectedToolCallIds` field. Determine coverage per occurrence, not by whether any other call in the chain has a summary. Retain these results in both zero-summary and partly summarized chains; do not add a summarizer call, rewrite existing batch summaries, protect tracker names globally, or exempt the chain from compression. Existing collision/range safeguards still apply. Each compressed chain is registered as a `context-prune-chain` session entry as today, so the first request renders it compressed. The cleanup makes no model call. It prints no notice; the existing compressed-chain counter and `cost:external` emission in `compactChains` cover it.

The idle cleanup adds no exception to row 1: zero-summary chains still receive the deterministic body and existing backfill, and partly summarized chains still carry their existing summaries. Both additionally retain never-summarized result text through the existing protected-output relocation. The first targeted workflow comparison and its confirmation run both scored fresh 3/3 versus paused 0/3: the previous design dropped the latest unsummarized tracker state from a partly summarized chain. This evidence requires retaining that text, not accepting the loss. Keep the same workflow fixtures and scoring; rerun after the repair. Rolling-window and manual compression retain their prior behavior.

The first reply resets the clock. A second prompt submitted before any reply finds every eligible chain already compressed and writes nothing.

### Regression harness (eval)

The seven-case corpus in `eval/scenarios/`, `PIPELINE_SETTINGS`, and both committed baselines stay byte-identical.

- `eval/scenario.ts`: `seedEntries(history, endMs)` stamps entries in 1000 ms steps ending at `endMs` (the session header takes the first stamp). `Scenario` gains optional `seedAgeMinutes?: number` (default 0), `twinOf?: string` (the fresh twin's id), and `unsummarizedIds?: string[]` (seeded ids the fixture places in a batch below `minBatchChars`, so the flush never summarizes them). A seeded assistant turn gains optional `stopReason?: "error" | "aborted"`; without it the stop reason is derived as today.
- `eval/config.ts`: add `IDLE_PIPELINE_SETTINGS`, equal to `PIPELINE_SETTINGS` with `chainCompression.idleCleanupMinutes: 180`. `protectedTools` stays `[]`, the production default, so tracker results take the default path; the skill file is protected by the existing `protectedPaths` entry `**/skills/**/*.md`.
- `eval/session.ts`: seeds with `endMs = Date.now() - seedAgeMinutes * 60_000`; takes the suite as an argument and resolves the scenario directory and settings from it. The seven-case suite keeps today's proofs unchanged. For the idle suite the flush proof and the request proof sort every seeded id into one of three classes and hold each class to its own obligation:

  | Class | After the flush (`error:no-flush`) | In the first subject request (`error:not-pruned`) |
  |---|---|---|
  | Protected: the suite's settings protect the call (tool name in `protectedTools`, or a `read` whose `path` matches `protectedPaths`) | not in the index | result text present word for word, in its own `toolResult` message or in a `<protected-output>` block |
  | Never summarized: listed in `unsummarizedIds` | not in the index | outside a compressed chain: its `toolResult` message with the raw text; inside one: no `toolResult` message for the id, but its extracted result text remains word for word in the chain's protected-output relocation |
  | Summarized: every other seeded id | in the index | raw text absent; outside a compressed chain: its summary-stub `toolResult` message with its ref, as today; inside one: no `toolResult` message for the id |

  An id is inside a compressed chain when a `context-prune-chain` entry on the branch lists it in `droppedToolCallIds` and the request carries that entry's `<compressed-chain id="...">` message; chain membership stands in for the individual stub that compression removed. The summary-presence clause accepts a batch summary's text inside a compressed chain body. The flush proof still requires a summarized flush. For the idle suite one more proof applies, `error:idle-arm`: the first subject request of a paused twin carries a `<compressed-chain` message for every closed chain of the fixture, and a fresh twin's carries none.
- `eval/scenarios-idle/`: four files. Every fixture has at most three tool-using closed chains (`rollingWindow` is 3), so the flush before the probe compresses none of them in either twin, and every chain - the newest included - holds at least one tool call the suite does not protect, so the paused twin compresses all of them.
  - `skill-gate-reply.ts`: history: a skill file read, ordinary tool work in the same chain, a final approval question with lettered options; the skill file names each letter's next step with a distinct literal token. Probe: one letter. `mechanical.contains`: that letter's token. Judged on the reply taking the step the skill prescribes for that letter and no other letter's step. `skill-gate-reply-paused.ts` imports the fresh scenario and sets `seedAgeMinutes: 240` and `twinOf`.
  - `plan-progress-continue.ts`: history: three tool-using closed chains carrying `plan_tracker` and `phase_tracker` results through each state the cleanup meets under the default configuration. Chain 1, summarized: tracker results in a batch the flush summarizes, marking an earlier task in progress. Chain 2, zero-summary: its only tool work is a tracker batch below `minBatchChars`, marking a second task in progress. Chain 3, partly summarized and interrupted: a summarized batch of ordinary work, then a tracker batch below `minBatchChars` whose `plan_tracker` result is the latest and marks the scored task in progress, closed by a text-only assistant message with `stopReason: "error"`. The never-summarized tracker ids are listed in `unsummarizedIds`, and the flush proof fails the job when the fixture did not reach these states. Probe: "Continue." `mechanical.contains`: the scored task's name. Judged on resuming at the task the latest result marks in progress. `plan-progress-continue-paused.ts` is its twin.
- `eval/run.ts`: add `--idle`. It is exclusive with `--baseline` and `--compare`, requires `--change`, accepts `--summarizer` and `--runs` as today, loads only `eval/scenarios-idle/`, reads and writes no baseline, and writes its report to the temp root. For each twin pair it prints `fresh n/3, paused m/3`. A fresh twin that passes fewer than all of its runs prints `INCONCLUSIVE` and exits 1, whatever the paused count: an unsolved control proves nothing. Otherwise `m < n` prints `REGRESSION CANDIDATE` and exits 1. Execution errors exit 1.
- `eval/report.ts`: the twin comparison text for `--idle`, including the `INCONCLUSIVE` label.

### Real-session replay

Add an `idle` subcommand to `eval/replay/run.ts` (module `eval/replay/idle.ts`). `npm run eval:replay -- idle <session dir>... [--out <dir>] [--minutes <n>]` makes no model call and no network call. For each session file's active branch it measures every historical return on its own terms. For each user message entry it calls `idleCleanupDue` with `branch` set to the active-branch entries strictly before that entry, `now` set to `Date.parse` of that entry's `timestamp`, the threshold, and no declared lifetime. The full leaf branch and the wall clock are never passed: with them a session that ends on recent activity would report no historical return. For each entry that is due it rebuilds the state before that message with the production indexer reconstruction and renders the request twice with `pruneMessages`: as it stood, and after the idle step - the closed-chain supersede activation of Trigger step 5 plus `compressEligible(chains, 0, ...)` with no fuser, literal entries, and an in-memory `appendEntry`. Settings come from the production loader over the operator's agent dir; `--minutes` overrides the threshold.

It fails (exit 1) when, at any return, the cleaned render lacks a byte-equal copy of any of these from the unchanged render: a user message; the final assistant text of a chain it compressed; a batch summary's text, including a summary message a compressed chain owns wherever that message sits; the extracted text of a protected output other than a read replaced by the superseded placeholder; any never-summarized result's extracted text in a chain compressed by idle cleanup; or any message of the turn in progress as "Readings of ticket rows" defines it, by ownership. The protected-output check compares extracted text (`extractToolResultText`, image blocks as their `[image returned: ...]` markers); the report labels it that way and claims nothing about original image blocks. It reports returns found, returns checked, violations, and estimated tokens removed (total and median share of the prompt). Output goes outside every checkout through the existing `assertOutsideRepo` path rule; violation records carry a session stem and entry index only, never content.

### Paid and external actions

Runner for all four: the implementing agent during rows and the main loop at finish. Run paid comparisons on a clean committed candidate. When the loop's pending ledger edit makes the implementation checkout dirty, use a temporary detached checkout of its exact committed HEAD outside the repository for evaluation only; record that revision with the result, keep outputs outside checkouts, and make no implementation edits there. Uncommitted source changes are never represented as tested by that run. Reuse the saved comparison for ledger evidence only while its candidate code and fixtures still match; offline report validation must fail for missing, stale, inconclusive, or regressed results. This resolves the row 11 clean-tree preflight failure without cutting either regression criterion or weakening the preflight. Approving this spec authorizes every action below for the whole flow - seed, rows, repairs, and finish - without per-step permission prompts; stated counts are advisory.

1. `npm run eval -- --idle --summarizer anthropic/claude-haiku-5-5 --change "idle cleanup twins"`: four idle scenarios, three runs, 12 jobs; subject `anthropic/claude-sonnet-5-5`, judge `anthropic/claude-opus-5-5`; credentials from the operator's agent dir. The result is evidence for the default tracker configuration only.
2. The same command once more when a paused twin passes fewer runs than its fresh twin. When the re-run repeats the drop for the same pair, the regression is confirmed: keep both run directories and block delivery. Under the requester's instruction to fix what can be fixed and continue to the ship menu, repair the cause, retain the fixtures and scoring, and rerun only after a candidate change. Do not repeat an unchanged failing paid comparison. A confirmed drop in the workflow pair is a delivery blocker like any other, including when it traces to a chain the flush never summarized; it is not an accepted degradation. When a pair is `INCONCLUSIVE`, retain its run directory and repair the fixture before claiming the row; never treat inconclusive evidence as passing.
3. `npm run eval:replay -- idle <the requester's private session directories for consumer repo A, consumer repo B, and pi-gauntlet> --out <directory outside every checkout>`: no model calls. It runs under the requester's live settings, which protect both trackers, so it is the structural evidence for that configuration. Only aggregate counts reach a commit body.
4. The AGENTS.md smoke run: `pi -e ./index.ts --no-extensions -p "..."` against an isolated `$PI_CODING_AGENT_DIR`, on a session seeded past the threshold, checking a `context-prune-chain` entry is written before the first request. This is the no-UI path: re-armed work is not flushed first, so a chain without summaries takes the deterministic body.

Not run for this change, at the requester's instruction ("targeted and not full sweep"): `npm run eval -- --baseline` and the seven-case `npm run eval -- --change` comparison. `eval/README.md` asks for a recapture after a harness change, and this change edits the harness (the seed clock and the session proofs). Three offline checks stand in for the sweep: the seven-case corpus hash and settings hash are unchanged, so the comparison key still matches both baselines; no seven-case scenario is past the threshold at its probe, so the cleanup cannot fire there; and the seven-case suite keeps its session proofs unchanged. Those checks do not prove that a seven-case request is byte-identical under the new seed clock. That rests on the code fact that seed timestamps reach the model only through the deterministic body's `Span:` line, which no seven-case request carries, and it is not measured by a paid run. The implementation commit body records `eval: run - idle twins <fresh/paused counts>; seven-case comparison not run - targeted at the requester's instruction, seeds are fresh so the cleanup cannot fire there`.

## Errors and edge cases

- Branch with no assistant message and no `cache_warm` entry, or a newest timestamp later than now: no cleanup.
- `idleCleanupMinutes` not a finite number above zero: loads as 180.
- No active model, or a model with no declared lifetime for the tier: the threshold alone decides. Retention `none` is not visible to the handler: the tier comes from `PI_CACHE_RETENTION` (`long`, else `short`), and a request's own retention setting is out of scope.
- Declared lifetime longer than the threshold (a 24-hour cache, or a custom threshold below the model's short lifetime): the lifetime is the threshold.
- Run started by an extension (`pi.sendUserMessage()`, or a custom message with `triggerTurn`): the flush step runs as today and the idle step does not.
- Pending batches or a settled flush at submission: the existing flush step runs first, then the check runs. A flush in flight that the handler does not await (`isFlushing`): no cleanup for that prompt.
- Flush step skipped or failed - a no-UI session with only re-armed work, or `flushPending` returning a failure: the cleanup still runs and compresses the unsummarized chains with the existing outcomes in "Trigger". A chain with no summary takes the deterministic body. Both zero-summary and partly summarized chains retain never-summarized result text through protected-output relocation.
- Summarizer outage: the cleanup makes no summarizer call, but the chains the outage left unsummarized get the same two outcomes.
- Chain closed by an assistant message that ended in `error` or `aborted` without tool calls: a finished turn, compressed like any other. A chain whose last assistant message holds tool calls stays open and untouched.
- Older superseded read inside the turn in progress: not activated by the cleanup; it keeps the state it would have without it.
- Reopened session: `session_start` has already set `supersede.floor = 0` for the whole branch, as today; the idle step adds only the chain compression.
- `compactChains` throws: the cleanup is a partial commit with no rollback. Every chain whose `context-prune-chain` entry was appended before the throw stays compressed, in this request and after a reload; the closed-chain supersede activation of step 5 stays; the remaining chains stay raw. The request is therefore not promised to equal the one sent without the cleanup. The prompt is sent, never blocked. One diagnostic goes through the existing sink (`src/diagnostics.ts`), new kind `idle-cleanup-failed`, dedup key the pause's `lastCacheRefreshMs` value as a string, so retries within one pause write one entry. The new kind is added to the `DiagnosticKind` union (`src/types.ts`), to the `DiagnosticSink` counter initialization (`src/diagnostics.ts`), and to the footer segment in `pruneStatusText` (`src/commands.ts`) as letter `i`. A second prompt before any reply retries the chains still raw.
- Prompt aborted before any reply: compressed chains stay registered; the next prompt finds the clock still past the threshold, the closed-chain reads already activated, and no chain left to compress, so nothing changes.
- Chain in recovery grace, with no tool work, holding only protected output, or with an unresolvable range: skipped by the existing rules; the rolling window compresses a graced chain later.
- After tree navigation or a fork: the pause is read from the active branch.
- No-UI sessions (`pi -p`, SDK hosts): the check runs for them too; a resumed print session past the threshold is cleaned before its only request.
- `pruneOn: on-demand`: no idle cleanup; `/pruner compact` stays the manual path.

## Tests

Titles below match the source, including parameter placeholders. Rows 11 and 12 require paid action 1 using `eval/scenarios-idle/skill-gate-reply.ts`, `eval/scenarios-idle/plan-progress-continue.ts`, and their paused twins; the listed tests validate their fixtures, not the paid behavior. Row 13 is a documentation check, not an automated test.

- Row 1, every tool-using closed chain compressed past the default threshold, the newest three included - `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)"
- Row 1, the four existing exceptions stay as they are - `src/idle-cleanup.integration.test.ts` "keeps %s chains while compressing eligible neighbors"
- Row 2, the waiting superseded read becomes its placeholder - `src/idle-cleanup.integration.test.ts` "stubs a waiting superseded protected read (%j)"
- Row 1, a chain closed by a text-only assistant message with `stopReason` `error` or `aborted` is compressed - `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)" (`stopReason` cases)
- Row 3, user message, final answer, batch summaries, and protected outputs byte-equal; no fused text - `src/idle-cleanup.integration.test.ts` "keeps literal idle summaries and protected outputs across reload, while compact keeps its rendering (%j)"
- Row 3, a batch summary holding a resolvable `{bN}` reference renders with the reference as written, before and after the session is rebuilt from entries; the same summary under `/pruner compact` renders substituted - `src/idle-cleanup.integration.test.ts` "keeps literal idle summaries and protected outputs across reload, while compact keeps its rendering (%j)"
- Row 3, protected `plan_tracker` and `phase_tracker` results (the requester's configuration) relocate into the chain body word for word - `src/idle-cleanup.integration.test.ts` "keeps literal idle summaries and protected outputs across reload, while compact keeps its rendering (%j)"
- Row 4, every message of the turn in progress byte-equal, an aborted run's open chain included; a summary message owned by the last closed chain is excluded from that comparison and its text is checked inside the chain body - `src/idle-cleanup.integration.test.ts` "keeps the turn in progress and any pending cold floor (%s)"
- Row 4 over row 2, two protected reads of one file inside an aborted run's open chain, the later covering the earlier, render as they do without the cleanup - `src/idle-cleanup.integration.test.ts` "keeps the turn in progress and any pending cold floor (%s)"
- Row 5, short pause renders identically and writes no entry - `src/idle-cleanup.integration.test.ts` "does nothing below the threshold (hasUI=%s)"
- Row 6, a `cache_warm` entry newer than the threshold renders identically - `src/idle-cleanup.integration.test.ts` "a cache-warm entry restarts the clock (%j)"; `src/idle-pause.test.ts` "takes the newest of assistant and cache-warm timestamps (%j)"
- Row 6, both entry kinds are read from the ISO entry `timestamp`; an assistant entry whose `message.timestamp` disagrees with it is timed by the entry `timestamp` - `src/idle-pause.test.ts` "reads the entry timestamp for both kinds (%j)"
- Row 7, a session rebuilt from entries by `boot()` and given its first prompt past the threshold is cleaned - `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)"
- Row 8, a declared lifetime longer than the threshold replaces it in both directions - `src/idle-pause.test.ts` "uses the longer of the declared lifetime and threshold (%j)"
- Row 8 through the handler and the real `getPromptCacheTtlMs`: a model whose `promptCache` lifetime is longer than a custom threshold gets no cleanup below the lifetime and the cleanup above it; `PI_CACHE_RETENTION` is set for the test and restored after it - `src/idle-cleanup.integration.test.ts` "the handler passes the model's declared lifetime (%j)"
- Row 9, no declared lifetime uses the threshold - `src/idle-pause.test.ts` "expires strictly after the threshold for %s"
- Row 9 through the handler and the real helper: a model without `promptCache` is cleaned past the threshold, with `PI_CACHE_RETENTION` isolated the same way - `src/idle-cleanup.integration.test.ts` "a model without a declared lifetime uses the threshold (%j)"
- Row 10, another duration - `src/idle-pause.test.ts` "uses the longer of the declared lifetime and threshold (%j)"; `src/idle-cleanup.integration.test.ts` "honors a custom threshold loaded from partial settings (%j)"
- Row 11 fixture - `eval/scenarios-idle.test.ts` "skill twins share synthetic history and differ only in pause metadata"
- Row 12 fixture - `eval/scenarios-idle.test.ts` "workflow twins cover summarized, zero-summary, and interrupted partial chains"
- Empty branch and future timestamp give no cleanup - `src/idle-pause.test.ts` "does not invent a refresh time (%j)"; `src/idle-pause.test.ts` "does not clean when the newest refresh is in the future"
- Setting default, invalid-value fallback - `src/config.test.ts` "defaults the idle threshold in old or partial settings (%j)"; `src/config.test.ts` "falls back to 180 for an invalid threshold (%j)"
- Overlay item - `src/commands.test.ts` "cycles and saves all four idle thresholds beside the chain window"
- `/pruner compact` still fuses by default, substitutes block references, and lowers the floor - `src/idle-cleanup.integration.test.ts` "keeps literal idle summaries and protected outputs across reload, while compact keeps its rendering (%j)" (index-level: `src/commands.ts` only receives `compactChains` as an injected function)
- Off when pruning or chain compression is off, or pruning is on demand; skipped while a flush is in flight - `src/idle-cleanup.integration.test.ts` "gates idle compression by human submission, automatic pruning, and a live session (%j)"; `src/idle-cleanup.integration.test.ts` "skips idle cleanup for an unawaited budget flush still in flight at submission"
- Human gate: custom-message and extension-source input events past the threshold get no cleanup; a human-submitted prompt gets the cleanup - `src/idle-cleanup.integration.test.ts` "gates idle compression by human submission, automatic pruning, and a live session (%j)"; `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)"
- Flush step skipped or failed, then cleanup: a no-UI session with re-armed work, and a `flushPending` failure - `src/idle-cleanup.integration.test.ts` "compresses re-armed no-UI chains without flushing before the first request"; `src/idle-cleanup.integration.test.ts` "awaits a settled flush (%s) before idle cleanup and the first request" (`error` case)
- Idle zero-summary and partly summarized chains retain every never-summarized result's extracted text, including latest tracker state, before and after reload; existing summaries remain literal and manual/rolling compression stays unchanged - `src/idle-cleanup.integration.test.ts` "retains unsummarized occurrences in idle chains across reload without changing manual compression (idle=%s)"; `src/chain-compressor.test.ts` "idle retention uses summary coverage, not index membership (covered=%s)"
- Replay requires byte-equal never-summarized result text in idle-compressed chains as well as the original protected-output invariants - `eval/replay/idle.test.ts` "idle keeps partly summarized chains, owned summaries, protected image marker text and open messages"; `eval/replay/idle.test.ts` "idle fails a seeded %s preservation violation without leaking content"
- `compactChains` failing before any append: one `idle-cleanup-failed` diagnostic, no chain compressed, the closed-chain supersede activation kept, the prompt sent - `src/idle-cleanup.integration.test.ts` "continues the prompt on failure $failure, preserving partial cleanup across retries and reload" (`before the first append` case)
- `compactChains` failing after one successful append: that chain stays compressed in the request and after reload, the rest stay raw, one diagnostic, and a retry in the same pause writes no second diagnostic - `src/idle-cleanup.integration.test.ts` "continues the prompt on failure $failure, preserving partial cleanup across retries and reload" (`after one append` case)
- `idle-cleanup-failed` counter starts at zero and shows as `i<N>` in the footer segment - `src/diagnostics.test.ts` "counts are per kind and start at zero"; `src/commands.test.ts` "appends b<N> for backfill-empty and i<N> for idle-cleanup-failed alongside u/m/o"
- Second prompt before any reply writes nothing - `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)"
- No-UI session past the threshold is cleaned - `src/idle-cleanup.integration.test.ts` "compresses every closed tool-using chain past the threshold (%j)" (`hasUI: false` cases)
- Seed clock ends at `endMs`; no seven-case scenario is past the threshold at its probe; the seven-case corpus hash and settings hash are unchanged - `eval/scenarios-idle.test.ts` "fresh seed clock preserves the seven-case comparison keys"
- Idle suite validation (twins share one history, `twinOf` resolves, `seedAgeMinutes` exceeds the suite threshold, fixtures synthetic, at most three tool-using closed chains, every chain holds a tool call the suite does not protect, `unsummarizedIds` name seeded ids, each scenario has a `mechanical.contains` token) - `eval/scenarios-idle.test.ts` "skill twins share synthetic history and differ only in pause metadata"; `eval/scenarios-idle.test.ts` "workflow twins cover summarized, zero-summary, and interrupted partial chains"; `eval/scenarios-idle.test.ts` "$id reaches only the intended idle arm"
- Idle-suite session proofs, a passing and a failing case for each class: a protected id (text present passes; text missing fails; indexed fails), a never-summarized id (raw outside a chain passes; indexed fails), a summarized id outside a chain (stub passes; raw text fails), a summarized id inside a compressed chain (chain membership passes; neither stub nor chain fails); `error:idle-arm` for a paused twin with a raw closed chain and for a fresh twin with a compressed one; the seven-case proofs unchanged - `eval/session.test.ts` "idle flush class proof: $label"; `eval/session.test.ts` "idle request class proof: $label"; `eval/lifecycle.test.ts` "%s traverses real SDK flush, pruning, recovery and scoring"
- `--idle` argument rules, no baseline read or write, twin comparison text and exit codes, `INCONCLUSIVE` with exit 1 when a fresh twin fails a run (fresh 0/3, paused 0/3 included) - `eval/report.test.ts` "idle rejects incompatible or unannotated invocation %j"; `eval/report.test.ts` "idle requires a change and keeps the selected run count"; `eval/report.test.ts` "idle loads only twins, never reads or writes a baseline, and retains pair metadata"; `eval/report.test.ts` "idle twin floor fresh $fresh paused $paused"; real SDK idle arm - `eval/lifecycle.test.ts` "%s proves the real SDK idle arm before scoring"
- `idle` replay over a synthetic session directory: counts, a seeded violation fails, output refused inside a checkout; two historical returns followed by recent activity are both found; a summary message owned by a compressed chain is not reported as a turn-in-progress violation; a protected image result is compared by its marker text - `eval/replay/idle.test.ts` "idle dispatch finds both historical returns despite later activity, without a model runtime"; `eval/replay/idle.test.ts` "idle fails a seeded %s preservation violation without leaking content"; `eval/replay/idle.test.ts` "idle refuses checkout output before opening input or creating directories"; `eval/replay/idle.test.ts` "idle keeps partly summarized chains, owned summaries, protected image marker text and open messages"

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` ("Cadence" paragraph and "Rolling window": the idle pause as a sixth cold moment that only a human-submitted prompt triggers, the threshold and declared-lifetime rule, what restarts the clock, what stays word for word - a protected image output as its `[image returned: ...]` marker text, a `{bN}` reference in a batch summary as written - why fusing is excluded, that the cleanup activates superseded reads in finished turns only, and what it does to work the flush never summarized: deterministic body for a chain with no summary, with never-summarized result text retained in both zero-summary and partly summarized chains - architecture and non-obvious rationale; "Session entry types": the `literalSummary` chain-entry field; "Diagnostics" table, session-entry row, and status-line paragraph: the `idle-cleanup-failed` kind, its dedup key, and widget letter `i` - operations); `doc/configuration.md` (the `chainCompression.idleCleanupMinutes` row and example key - tunable parameter); `README.md` (one row in "Configuration - the knobs most people touch" - tunable parameter); `eval/README.md` (the idle suite, `--idle`, twin comparison rule with the fresh-control floor and `INCONCLUSIVE`, the configuration the twins are evidence for, the `idle` replay, and why the seed-clock change keeps the seven-case baselines comparable without a recapture and what the offline checks do not prove - procedure); `AGENTS.md` "Behavioral eval" (when to run `--idle` and the `idle` replay - procedure); `CHANGELOG.md` (`## [Unreleased]` entry with `(#39)`)
- Derived / memory docs invalidated: none

## Out of scope

- A pause inside a running run, including the 5 to 90 minute dispatch waits measured in jjuraszek/pi-gauntlet#67.
- Timing the cleanup by each model's declared lifetime below the threshold, or by a request's own retention setting.
- Summary fusing, a new summarization pass, or any change to protected content beyond the existing superseded-read placeholder.
- The idle cleanup in `pruneOn: on-demand`.
- The idle cleanup for a run an extension starts.
- Rolling back a cleanup that failed part-way, an exemption from compression for chains the flush step left unsummarized, and an exemption for a chain closed by an interrupted text-only message.
- A separate off value, and a user-facing notice.
- Recapturing the eval baselines or adding cases to the seven-case corpus.
- Full cache rewrites with no pause before them.

## Open questions

- A provider with a long cache and no declared lifetime in pi's catalog (for example an OpenAI-compatible 24-hour tier) is cleaned at the threshold while its cache may be warm; the cost is one rewrite, and raising `idleCleanupMinutes` is the remedy. Not observed in the measured corpus.
- The paid twin run uses one summarizer (`anthropic/claude-haiku-5-5`), since the cleanup calls no summarizer; `--summarizer` can name the other.
- Whether overnight returns in the corpus kept the process or reopened the session is not recorded; both paths are tested.
