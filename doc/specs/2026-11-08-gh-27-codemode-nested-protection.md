# Nested-call protection: `protectedPaths` covers reads made inside codemode scripts

**Goal:** A tool result whose recorded nested calls include a protected call (by `protectedPaths` glob or `protectedTools` name), or whose nested-call record is incomplete, is protected exactly like a direct protected call - never summarized, never indexed by a new capture (an index entry written by an older version stays stored and is not applied), kept verbatim in context - with no new configuration.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

GitHub issue: [#27](https://github.com/jjuraszek/pi-condense/issues/27)

supersedes `doc/specs/2026-06-11-protected-paths.md`, "Defaults and matching" (the "Matched argument: `args.path` only" row) and "Wiring" (the "toolResult fallback stays name-only: results carry no args" clause). Every other section of that spec stays live, including its "Repairing already-summarized reads" mechanism, which this spec reuses unchanged.

## Problem

`isProtected(toolName, args, config)` in `src/protected.ts` decides protection from the tool call's own name and `args.path`. A codemode script that runs `console.log(await tools.read({ path: "skills/x/SKILL.md" }))` prints the skill body into the codemode result, but the top-level call carries `code`, not `path`, so the predicate never matches and the result is summarized like any other tool output. The scenario is derived from the code and pi's runtime contract, not an observed live-session failure.

Pi already records what a script called. `ToolResultMessage.nestedCalls?: NestedToolCalls` is a top-level field (not `details`) with `{ calls: NestedToolCallRecord[], complete: boolean }`, where each record is `{ id, name, arguments?, argumentsBytes?, status, durationMs?, error? }` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:408-436`). The recorder (`node_modules/@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js:16-76`) caps the record at 256 calls, 8 KiB of arguments per call and 32 KiB total; a call over a limit is recorded with `argumentsBytes` and no `arguments`, and `complete` flips to `false` in the same step; dropped or unfinished calls also set `complete = false`; `snapshot()` returns `undefined` when the tool made no nested call. Nested calls made by nested tools are flattened into the same record. Pi attaches the record to the result object at `message_start` (`agent-session.js:727-733`) and hands the same object to the extension's `turn_end` boundary (`agent-session.js:500-526`, `pi-agent-core/dist/agent-loop.js:171-185`), and the persisted session message carries it, so live capture, `getBranch()` and the `context`-event messages all see it. Pi's own compaction consumer reads the field generically (`dist/core/compaction/utils.js:17-20`). Codemode is the only core tool that calls `ctx.executeTool` today; the record is not codemode-specific.

The existing escape hatch, `protectedTools: ["codemode"]`, keeps every script result verbatim regardless of what it read; the ticket names it and rejects it in favor of selective matching.

Framing: kept - the user chose to match on any tool result carrying `nestedCalls`, with no tool-name check and no new config key: a generalization of the existing rule, not a codemode feature. Premise corrections carried from the questionary: the ticket's "a `read` with no `arguments`" case is always inside the `complete === false` case (the recorder omits arguments and flips `complete` in one step), so the design treats it as one rule with two tests; and `nestedCalls` is generic to any tool that calls `ctx.executeTool`, which is why the match has no tool-name constant. Unverified: no live codemode session was run during design; the end-to-end claim that `nestedCalls` reaches the `turn_end` handler rests on the object-identity trace above and is confirmed by the smoke run named under Verification.

## Acceptance criteria

Ticket #27, `## Acceptance Criteria`, rows verbatim:

- [ ] A `codemode` toolResult whose `nestedCalls.calls` includes `{ name: "read", arguments: { path } }` with `path` matching `protectedPaths` is treated as protected by chain detection, batch capture, live capture, and the pruner, and is never summarized (unit tests beside the existing protection tests).
  in-scope
- [ ] A `codemode` toolResult whose `nestedCalls.calls` includes a call whose `name` matches `protectedTools` is treated as protected the same way (unit test).
  in-scope
- [ ] A `codemode` toolResult whose `nestedCalls.complete` is `false`, or whose `nestedCalls.calls` includes a `read` with no `arguments`, is treated as protected (unit tests).
  in-scope
- [ ] A `codemode` toolResult with no `nestedCalls`, or with a complete record where no nested call matches `protectedTools` or `protectedPaths`, stays prunable; existing top-level `protectedTools`/`protectedPaths` matching is unchanged (unit tests).
  in-scope
- [ ] The `protectedPaths` row in the README and `doc/configuration.md` states that reads made inside codemode scripts are covered through the result's recorded nested calls, and that incomplete records are kept verbatim.
  in-scope

Reading of rows 1-4: the rows name `codemode` because it is the only tool that produces `nestedCalls` today; the Design matches on the field, not the tool name, so a `codemode` result is the test subject and the rule holds for any tool result carrying the field. Row 3's "no `arguments`" case is satisfied through the `complete === false` clause (Design, "Rule") and tested as its own case. Row 3 carries no configuration exception, so the Design protects an incomplete record unconditionally; `protectedPaths: []` (the documented kill switch) disables path matching only.

## Legs

### Leg: pi-condense
branch: gh-27-codemode-nested-protection
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `bun test src/`; typecheck `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove, never committed); smoke `pi -e ./index.ts --no-extensions --tools +codemode -p "..."` against an isolated `$PI_CODING_AGENT_DIR` with the `jq` customType count from AGENTS.md; `npm run eval -- --change "<why>"` once at finish; the plan is `git rm`-ed before the branch finishes (`.pi/gauntlet-overrides.md`, "Plan retention")
Rules: AGENTS.md
Rules: README.md
Rules: PRUNING.md
Rules: eval/README.md
Rules: .agents/skills/release/SKILL.md
Rules: CHANGELOG.md
Rules: .pi/gauntlet-overrides.md
Rules: AGENTS.core.md
scope: none
design: owns every path in Design; the observable outcomes are the five acceptance rows above.

## Design

### Rule

Today's direct-call matcher (`src/protected.ts:49-56`) is kept as-is and becomes the shared matcher `matches(name, args)`: `name` is in `protectedTools`, or `protectedPaths` is non-empty and `args.path` is a string matching a `protectedPaths` glob. Its `protectedPaths.length === 0` short circuit stays inside the path branch of that matcher; it is not a guard ahead of the nested clauses (placing it there would defeat nested `protectedTools` matching when `protectedPaths` is empty). There is no both-lists-empty guard: today's code has none, and AC 3 names no configuration exception.

`isProtected(toolName, args, config, nestedCalls?)` returns `true` when any of the following holds, evaluated in this order:

1. `matches(toolName, args)` (today's rule, unchanged).
2. `nestedCalls` is present and `nestedCalls.complete === false` - unconditional, whatever `calls` contains and whatever the config lists hold.
3. `nestedCalls` is present and some `nestedCalls.calls[i]` satisfies `matches(calls[i].name, calls[i].arguments)` - the same matcher, the same glob list, no recursion (the recorder already flattens nested-of-nested calls).

Otherwise `false`.

`nestedCalls` is typed as pi-ai's `NestedToolCalls` (import type from `@earendil-works/pi-ai`, the same package the repo already types messages from); the parameter is optional so callers without a result in hand are unchanged. A nested record's `status` is ignored: an errored or unfinished read can still have printed partial text.

### Data flow

The field travels with the `ToolResultMessage` and is read where a protection decision already has that message in hand. No new state, no new persistence, no new config key.

| Site | Today | Change |
|---|---|---|
| `src/batch-capture.ts` `captureBatch` projection (lines 92-114) | copies `resultText`, `isError`, `resultTimestamp` from the matched result | also copies `match.nestedCalls` into a new optional `nestedCalls?: NestedToolCalls` field on `CapturedToolCall` (`src/types.ts:599`) |
| `index.ts:929` live filter | `isProtected(tc.toolName, tc.args, config)` | passes `tc.nestedCalls` as the fourth argument |
| `src/batch-capture.ts:131,194` rescan `exclude` predicate | `(toolName, args) => boolean`, called with the toolCall block | predicate type gains optional third parameter `nestedCalls?`; the call at line 194 passes `turnResults.get(id)?.nestedCalls` (the per-turn first-result pairing already in scope at line 176-180; no id-only global lookup) |
| `index.ts:65` `protectionPredicate` (injected into `detectChains`, `computeContextMetrics`, supersede, and as the `exclude` of `captureUnindexedBatchesFromSession` at `index.ts:191` - the only wiring through which the rescan row above receives its third argument) | `(name, args) => isProtected(name, args, config)` | `(name, args, nestedCalls?) => isProtected(name, args, config, nestedCalls)`; `src/chain-detector.ts:48` and `src/context-metrics.ts:52` widen their predicate parameter types to match |
| `src/chain-detector.ts:113` toolResult fallback | `isProtected(msg.toolName, undefined)` (name-only) | `isProtected(msg.toolName, undefined, msg.nestedCalls)`; a protected script result joins `protectedToolCallIds` like any protected call and relocates verbatim as `<protected-output tool="codemode">` through the existing `src/chain-range-prune.ts:174-216` path - it does not block compression |
| `src/pruner.ts:119` render-time re-check | `isProtected(record.toolName, record.args, protection)` | `isProtected(record.toolName, record.args, protection, msg.nestedCalls)` - `msg` is the live `ToolResultMessage` already in scope; the indexed record is untouched. This is the repair path for script results indexed and summarized by an older version: on the next render the raw result stays verbatim (same mechanism as the predecessor's "Repairing already-summarized reads") |
| `src/context-metrics.ts:159` frontier gap | `isProtected(m.toolName, args)` | `isProtected(m.toolName, args, m.nestedCalls)` so frontier accounting agrees with the pruner |
| `src/supersede.ts:89` | unchanged | per-path supersession of script results is out of scope (reporter note); the predicate call stays argument-only |
| `eval/replay/extract.ts:45` replay `exclude` callback | `(name, args) => isProtected(name, args, PIPELINE_SETTINGS)`; its return value decides which results enter replay batches (and so reach the summarizer in both arms), and it increments `protectedExclusions` | `(name, args, nestedCalls?) => isProtected(name, args, PIPELINE_SETTINGS, nestedCalls)`; a script result with a protected nested read is excluded from replay batches and counted, matching production (`eval/README.md`, "The extractor ... reuses production batch capture and protection rules") |
| `src/commands.ts:258` `protectedPathsDescription` (settings overlay text; no new row) | "Glob patterns matched against a tool call's `args.path` ... Set to 'none' to disable (kill switch)" | the existing string also says that the globs match reads recorded in a result's `nestedCalls` (reads made inside codemode scripts), that an incomplete nested-call record is kept verbatim regardless of this setting, and that `none` disables path matching only |

The summarizer never sees the new field: `serializeBatchForSummarizer` (`src/batch-capture.ts:226-249`) serializes `toolName`, `args`, `isError` and `resultText` explicitly, and the indexer record (`src/indexer.ts:493`) copies named fields. Summarizer serialization and prompt are unchanged; the replay harness change above alters which results are extracted, not how a batch is serialized (consequences under Verification).

**Remove:** the "results carry no args" assumption behind the name-only fallback in `src/chain-detector.ts:113` and its comment; nothing else.
**Add:** optional fourth parameter `nestedCalls?: NestedToolCalls` on `isProtected` (`src/protected.ts`); optional `nestedCalls?: NestedToolCalls` on `CapturedToolCall` (`src/types.ts`) and its copy in `captureBatch` (`src/batch-capture.ts`); the optional third parameter on the injected predicate type at `index.ts:65`, `src/chain-detector.ts:48`, `src/context-metrics.ts:52` and the `exclude` parameter at `src/batch-capture.ts:131`; the argument at the seven call sites in the table (`index.ts:929`, `src/batch-capture.ts:194`, `index.ts:65`, `src/chain-detector.ts:113`, `src/pruner.ts:119`, `src/context-metrics.ts:159`, `eval/replay/extract.ts:45`); the amended `protectedPathsDescription` string in `src/commands.ts`; tests listed under `## Tests`; the doc edits under `## Documentation impact`.
**Not added:** any config key; any tool-name constant; any `details`-based fallback (pi puts the record top-level only); any reconstruction of already-compressed chains (`context-prune-chain` entries keep their `protectedToolCallIds` fixed at compression time, the predecessor's declared limitation); any change to the summarizer prompt or input.

### Prompt-cache posture

Protection moves messages out of the pruner's reach, so a newly protected script result is one fewer rewrite of the prefix, not one more. The decision is a pure function of the message and the config, so two renders of the same history give the same answer. The existing repeatability case is `src/id-collision.integration.test.ts:183` "re-rendering the same session is deep-equal" (deep equality, no nested calls); the oracle for nested protection is the new `src/pruner.test.ts` case under `## Tests`, which asserts that two renders of a history containing a protected script result are byte-identical. Phase 1b supersession, the only path that rewrites an already-rendered protected read, is not extended to script results. The one-time flip a running session sees after upgrade - a script result that was stubbed and is now kept verbatim through the render-time re-check - happens once, at a position the pruner was already rewriting, and is the same repair the predecessor spec established for direct reads.

### Verification and paid actions

Implementation needs no paid or external action. Verification runs, in this order and once each across the whole flow:

- `bun test src/`, `npm run test:eval` (offline; covers the `eval/replay/extract.test.ts` case) and the typecheck command from AGENTS.md - local, free.
- One smoke session. Setup: an isolated `$PI_CODING_AGENT_DIR` whose `settings.json` holds `{ "contextPrune": { "enabled": true } }` (every other key at its default: `minBatchChars` 2000, default `protectedPaths`; `DEFAULT_CONFIG` has `enabled: false`, so without this file no capture handler runs and the exclusion check passes vacuously). Command: `pi -e ./index.ts --no-extensions --tools +codemode -p "<prompt>"` where the prompt makes the model (a) run a codemode script that reads a `**/skills/**/*.md` path and prints it, and (b) make an unprotected control tool call whose result exceeds 2000 chars (a nontrivial batch; a trivial one skips summarization and indexing, which would also leave no index entry). Witness of a completed flush: a `context-prune-index` entry carrying the control's toolCallId - without it the smoke is inconclusive, not a pass, and the prompt is adjusted and the session re-run (a re-run is a second paid session and needs its own go-ahead). Assertions on the session JSONL: the codemode `toolResult` carries `nestedCalls` with the protected `read`; the codemode toolCallId appears in no `context-prune-index` entry; the AGENTS.md `jq` customType count shows the expected entries. The smoke proves field delivery and index exclusion end to end; the handler-level test under `## Tests` (`turn_end` with a codemode result carrying `nestedCalls`) is what proves the result never enters summarizer input. Paid: one print-mode session incurs at least two assistant completions (the one that issues the tool calls and the follow-up after tool execution) plus, with pruning enabled, one summarizer call for the control batch - several model calls, not one - billed to the user's provider key.
- One behavioral eval at finish: `npm run eval -- --change "nested-call protection: isProtected reads ToolResultMessage.nestedCalls; incomplete records (recorder limits, unfinished calls) are kept verbatim and bypass the oversized spill"`. Required because this change touches `src/pruner.ts`, `src/batch-capture.ts`, `src/chain-detector.ts` and the `index.ts` capture hooks, which AGENTS.md names as eval-owning paths. No `--baseline` recapture: the comparison key (`eval/README.md`, "Comparison identity": corpus bytes, subject prompt, models, thinking, judge prompt, pipeline settings, repetition count) does not include `eval/replay/extract.ts`, and the behavioral eval under `eval/` does not import the replay extractor. The replay harness change has its own consequence: a private corpus extracted before this change is not comparable with one extracted after it (the extractor now drops nested-protected results), so any later replay run re-extracts first. No private-session replay run in this change (summarizer serialization and prompt unchanged).

The only paid actions are the one smoke session and the one behavioral eval run above; the session's multi-call cost description replaces the earlier "one model call" wording and is what gate approval authorizes.

Design approval authorizes exactly these actions. The loop treats any action not named here as unreachable; adding one needs separate explicit authorization.

## Errors and edge cases

| Case | Behavior |
|---|---|
| `nestedCalls` absent | clause 1 only (today's behavior). Pi never attaches an empty record; `calls: []` with `complete: true`, if hand-made, matches nothing in clause 3 and the answer is clause 1's |
| `complete === false` | protected, whatever `calls` contains |
| `complete === false`, both config lists empty (or `protectedPaths: []` kill switch) | protected - AC 3 names no configuration exception; the kill switch disables path matching only |
| `protectedPaths: []`, nested call whose `name` is in `protectedTools` | protected by clause 3 (the empty-path short circuit lives inside the matcher's path branch, not ahead of the nested clauses) |
| what trips `complete = false` in practice (`nested-tool-calls.js:16-76`) | any one nested call whose arguments exceed 8 KiB (one `write`/`edit` of a large file), more than 256 nested calls, more than 32 KiB of arguments in total, or a nested call still running when the script ends. Each of these protects the whole script result even when it read nothing protected - a consequence of the requested rule, carried into the user docs |
| incomplete-record result over `spillThreshold` (65536) | stays inline verbatim: the live filter at `index.ts:929` removes protected results before `spillOversizedBatch` sees the batch, so the oversized-spill backstop does not apply to a protected result |
| nested call with `arguments` omitted (over the per-call byte limit) | no path match from clause 3, but the recorder set `complete = false` in the same step, so protected by clause 2; this is the ticket's "a `read` with no `arguments`" case |
| nested `arguments.path` missing or non-string | that record does not match (existing rule) |
| nested `status` is `error` or `unfinished` | ignored for matching; `unfinished` also implies `complete === false` |
| nested call name in `protectedTools` | protected by clause 3 regardless of its arguments |
| malformed `nestedCalls` from a hand-edited session (not an object, `calls` not an array) | treated as absent; the predicate is total and never throws |
| `protectedTools: ["codemode"]` already configured | unchanged - clause 1 fires first |
| script result inside a closed chain | relocated verbatim as `<protected-output tool="codemode">`; the chain still compresses |
| script result already indexed and summarized by an older version, still in the branch | render-time re-check keeps the raw result verbatim on the next render; its index entry stays but is never applied |
| script result inside an already-compressed chain | not repaired (predecessor's declared limitation, unchanged) |

## Tests

- nested `read` with a `protectedPaths`-matching `path` -> protected - `src/protected.test.ts`
- nested call whose `name` is in `protectedTools` -> protected, arguments irrelevant - `src/protected.test.ts`
- `complete: false` with matching-free `calls` -> protected - `src/protected.test.ts`
- nested `read` with `arguments` omitted and `argumentsBytes` set, `complete: false` -> protected - `src/protected.test.ts`
- `complete: false` with both config lists empty -> protected; `protectedPaths: []` with a nested call whose `name` is in `protectedTools` -> protected - `src/protected.test.ts`
- no `nestedCalls` -> today's answer; complete record with no matching call -> not protected; existing top-level cases unchanged - `src/protected.test.ts` (existing cases stay green, two new cases)
- nested `status: "error"` with a protected path -> protected - `src/protected.test.ts`
- malformed `nestedCalls` (string, `calls` not an array) -> treated as absent, no throw - `src/protected.test.ts`
- `captureBatch` copies `nestedCalls` from the matched result into `CapturedToolCall`; absent when the result has none - `src/batch-capture.test.ts`
- `captureUnindexedBatchesFromSession` passes the matched result's `nestedCalls` to `exclude`, pairing per turn (repeated ids across turns get their own turn's result) - `src/batch-capture.test.ts`
- live capture filter drops a protected script result from the batch and keeps an unprotected one; the dropped one never reaches the summarizer or the index - `src/reload-rearm.integration.test.ts` pattern (handler-level `turn_end` with a codemode result carrying `nestedCalls`), new test beside it
- `detectChains` adds a script result with a protected nested read to `protectedToolCallIds` - `src/chain-detector.test.ts` (relocation of ids in `protectedToolCallIds` is already pinned by `src/chain-range-prune.test.ts:472-586`; no new relocation test)
- pruner render-time re-check keeps an indexed script result verbatim when its result carries a protected nested read; two renders of the same history are byte-identical (the cache-repeatability oracle named under "Prompt-cache posture") - `src/pruner.test.ts`
- frontier gap excludes a protected script result - `src/context-metrics.test.ts`
- `extractBranch` excludes a codemode result whose nested `read` matches a protected path from replay batches and counts it in `protectedExclusions` - `eval/replay/extract.test.ts` (existing extractor test gains the case)
- README and `doc/configuration.md` wording (AC 5) - none: documentation text, verified by the conformance check against this spec
- end-to-end `nestedCalls` reaching `turn_end` in a real pi session - none: the smoke run under Verification observes it; not a unit test because it needs a live model call

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - "Configuration" table, `protectedTools` / `protectedPaths` row (line 175): add that reads made inside codemode scripts are covered through the result's recorded nested calls (`nestedCalls`), that a scripted read is kept verbatim and is not stubbed when a later read targets the same path (the row's existing "only the newest read per protected path stays verbatim" rule is specific to direct reads), and that an incomplete record (a nested call over the recorder's 8 KiB-per-call / 32 KiB-total / 256-call limits, or still running when the script ends) is kept verbatim regardless of `protectedPaths`, including when the result is over `spillThreshold` (AC 5; operations/tunable parameters); `doc/configuration.md` - "Every key" table, `protectedPaths` row (line 61): same clauses (AC 5; operations/tunable parameters); `PRUNING.md` - "Protected tools & paths" (line 636): the sentence "A tool call is protected if **either** its `toolName` is in `protectedTools` **or** its `args.path` (string) matches any glob in `protectedPaths`" gains the nested-call and incomplete-record clauses, and the following "until a later read of the same path covers its delivered lines and supersedes it" clause is qualified as direct reads only, because this paragraph is the canonical definition of "protected" that chain detection, capture, pruner and metrics all depend on (major definitions); `CHANGELOG.md` - `## [Unreleased]` gains an `### Added` bullet for nested-call protection ending `(#27)` (`.pi/gauntlet-overrides.md`, "refs"), written with the implementation because `release.sh` promotes the existing `## [Unreleased]` section and adds nothing to it (AGENTS.md, "Release")
- Derived / memory docs invalidated: `doc/specs/2026-06-11-protected-paths.md` - supersession banner for its "Defaults and matching" and "Wiring" scope (see `reference/documentation-impact.md` for the bar applied above)

## Out of scope

- Per-path supersession for script results (the "newest read of the same path stays verbatim" rule never fires for a scripted read) - reporter note on #27; a separate decision.
- Reconstructing protected text inside already-compressed chains - predecessor's declared limitation, not asked for by #27.
- Changing default globs, adding an agents/persona default, or protecting all codemode output.
- A `details`-based or script-source-parsing fallback for runtimes that do not record `nestedCalls`.
- Any new config key, `/pruner` subcommand or settings-overlay row (the existing `protectedPaths` overlay description is reworded, not a row added).

## Open questions

- none
