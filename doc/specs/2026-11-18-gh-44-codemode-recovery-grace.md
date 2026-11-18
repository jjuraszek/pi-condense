# Recovery grace for scripted lookups: a tool result that records a nested `context_tree_query` earns the grace window

**Goal:** A tool result whose recorded nested calls include a call named `context_tree_query` is a recovery result: the shared grace check returns its occurrence key for the same window as a direct lookup, so rendering keeps it verbatim and chain compression defers its chain, with no new setting, stored state, or consumer change.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

**Ticket:** [jjuraszek/pi-condense#44](https://github.com/jjuraszek/pi-condense/issues/44)

supersedes `doc/specs/2026-07-06-recovery-grace-window.md`, "Decision" (which results earn grace: direct `context_tree_query` output only). Its window length, unit, fixed clock, config key, and render-time enforcement stay live.

## Problem

When the assistant looks up a pruned tool result, pi-condense gives the returned evidence a grace period before it can be shortened again. The assistant can also make that lookup inside a codemode script (`await tools.context_tree_query(...)`). Evidence returned through a script leaves context sooner than the same evidence returned directly: on pi-condense 2.18.0 the shared grace check `inGraceRecoveryToolCallIds` (`src/recovery-grace.ts`) matches only `m.toolName === QUERY_TOOL_NAME`, so a script result that recorded the lookup is stubbed at the next render and its closed chain stays eligible for compression.

Ticket scenario (synthetic, pi-condense 2.18.0 at `e89b045`): `recoveryGraceTurns` 3, rolling window 0, timestamped results, one summarized direct `context_tree_query` result and one summarized codemode result whose `nestedCalls` record names `context_tree_query`, same age, each in a closed chain. Observed: the direct result renders verbatim and its chain is deferred; the script result renders as a summary stub and its chain is eligible.

Framing: kept - no concern with a named alternative. `protectedTools: ["context_tree_query"]` already matches nested lookups but keeps the result forever and relocates it into the compressed chain instead of deferring the chain (`src/protected.ts:60-65`, `src/chain-detector.ts:109-113`, `PRUNING.md:653-657`), the unbounded regrowth the predecessor rejected. Grace per inner call is impossible: Pi records nested call names and arguments, never results (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:428-433`), so the whole outer result is the only granularity available.

Constraints carried from the ticket body:

- One existing shared grace check serves render pruning and chain-compression eligibility; no new setting or stored state.
- Grace covers the whole script result, not per-inner-call references.
- The match is "any tool result whose recorded nested calls include a lookup"; the outer tool name is not restricted.
- The inclusive final-turn boundary, the zero-disables rule, and occurrence isolation by numeric timestamp are preserved.

Reporter note (ticket comment, historical row wording before the rows were split): "A later result that reuses the same tool call ID does not inherit grace from the earlier lookup." The ticket body narrows this to a different timestamp (AC row 7) and states that results reusing an ID without a timestamp, or with an equal timestamp, keep sharing grace as direct lookups do today. The body governs; the broader sentence adds no requirement.

Operator requirements from the design discussion:

- Verification is unit tests plus the free offline idle replay, discovered and run by the flow with no operator input ("B, but do it automatically"). No paid eval, no live smoke session.
- Verification guards against regression (existing direct-lookup behavior and results with no recorded lookup behave as before) and against overuse (nothing earns grace except a recorded nested call whose name equals the lookup tool name exactly; the added retention is bounded by the same window).

Checked claims (worktree at `e89b045`, installed `@earendil-works/pi-ai` and `pi-coding-agent` 1.5.2):

| Claim | Lookup | Result |
|---|---|---|
| The shared grace check matches direct lookups only | `src/recovery-grace.ts:36`; `bun -e` probe with a direct result `d@10` and a `codemode` result `s@11` naming the lookup, `graceTurns` 3 | held - probe printed `[ "d@10" ]` |
| Render stubbing and chain deferral consume the one key set | `src/pruner.ts:94,137`; `src/chain-compressor.ts:20-27,45-57`; `index.ts:695,715,1225,1245`; `eval/replay/idle.ts:165` | held - five call sites, no second grace rule |
| The pruner looks the set up with the result's own occurrence key | `src/pruner.ts:120,137`; `src/recovery-grace.ts:37` | held - same `occKey(id, timestamp)` or bare-ID expression |
| A chain holding the script result exposes its key to the deferral check | `src/chain-detector.ts:109-113`; `src/chain-compressor.ts:20-27` | held |
| A tool result carries its nested-call record at `nestedCalls.calls[].name` | `pi-ai/dist/types.d.ts:414-443` | held |
| Render-time messages carry `nestedCalls` | `src/pruner.ts:134` reads `msg.nestedCalls` in the same loop | held |
| The branch projection keeps `nestedCalls` | `src/batch-capture.ts:17-21` returns `e.message` itself | held |
| Codemode records an inner lookup under the registered tool name | source trace (`codemode/execute.js:455-468`, `core/nested-tool-calls.js:36-52`, `core/agent-session.js:769-775`); `jq` over the operator's session files (outer tool name, `complete`, call names, call keys only) | held on live data - drafting count (historical, over the `rg`-prefiltered files): 21 recorded results in 12 session files have outer tool `codemode` and a nested call named `context_tree_query`; call keys are `arguments, durationMs, id, name, status`; 8 of the 21 are `complete: false` and still name the lookup. Confirmed selection (council review probe, `jq` on `toolResult` entries' `message.nestedCalls.calls[].name`): 24 results in 10 files, 8 with `complete: false`; two prefiltered files match only inside a `custom` entry and are not selected |
| "The same pattern as `isProtected`" (ticket pointer) | `src/protected.ts:60-65` | corrected - `isProtected` also returns true for any record with `complete === false`; copying that clause contradicts AC row 6, so only the array guard and the name match are used |
| A lookup dropped from the record past the 256-call cap | `core/nested-tool-calls.js:36-40`; `src/protected.ts:63` | no grace from this check (name not recorded); the result is already permanently protected as an incomplete record |
| Nested call `status` | `src/recovery-grace.ts:36` ignores `isError` for direct lookups; `PRUNING.md:653` | a recorded lookup counts whatever its status |
| AC rows are behavioral, not workflow-stage proofs | shape-ticket AC integrity gate table | held - no cut question |
| The paid seven-case eval and the idle twins can observe this change | `eval/README.md:29`; `rg -i 'codemode\|nestedCalls' eval` | corrected - no eval job loads codemode or a `nestedCalls` fixture, so the grace set is identical with and without the change |
| The eval baseline is comparable on the installed Pi | `eval/baseline/claude-haiku-5-5.md` `Versions:` (1.5.0) vs installed 1.5.2 | corrected - mismatch; `eval/README.md:83` calls it a blocker for a controlled comparison |
| The offline idle replay reaches the widened check on both paths | `eval/replay/idle.ts:16,165-171` | held - render receives `config.recoveryGraceTurns`; `compressEligible` receives `inGraceRecoveryToolCallIds(messages, ...)` |
| The replay can run without operator input | `PI_CONDENSE_SESSION_DIR`, `PI_CONDENSE_REPLAY_DIR`, `PI_CODING_AGENT_DIR` unset; default sessions directory exists; `eval/replay/idle.ts:129` reads each input directory non-recursively | held - prefilter count at drafting (historical): 6 directories directly hold an `rg`-prefiltered file (532 session files). Confirmed selection (council review probe, `jq` confirmation as in Design, "Selected directories"): 4 directories holding 530 session files, 10 of them confirmed |
| The replay passes today on the six prefiltered directories (historical; not a run over the confirmed selection) | `npm run eval:replay -- idle <6 dirs> --out <temp dir>` at `e89b045` | held for the prefiltered directories only - exit 0: sessionsRead 532, sessionsSkipped 0, returnsFound 80, returnsChecked 80, violations 0, pointerResultsChecked 300, estimatedTokensRemoved 9934296, medianPromptShareRemoved 0.2763 |
| The replay reaches the widened check on the confirmed affected files | council review probe: idle replay over temp copies of the 10 `jq`-confirmed files, once at HEAD and once with the Design's condition patched into a temp copy of `src` | held - 9 idle returns, 5 with an in-grace scripted lookup in a closed chain; `estimatedTokensRemoved` 866537.75 at HEAD and 835874.25 widened; violations 0 and sessionsSkipped 0 in both |
| The replay runs under settings where grace decides | `contextPrune` keys in the operator's agent `settings.json` | held - enabled, `pruneOn: "agent-message"`, `recoveryGraceTurns` 3, chain compression enabled, `protectedTools` holds only `plan_tracker`, `phase_tracker` |
| User-visible wording names only direct output | `PRUNING.md:192`, `doc/configuration.md:58`, `src/commands.ts:214-219` | held - three places to reword |
| Predecessor | `doc/specs/2026-07-06-recovery-grace-window.md`, "Decision" | held - this spec changes which results qualify and nothing else |

## Acceptance criteria

Ticket #44, "Acceptance Criteria", rows verbatim:

- [ ] When a summarized codemode result within the grace window records a nested `context_tree_query`, pruning keeps that result verbatim wherever it would keep a direct lookup verbatim.
  in-scope
- [ ] When a codemode result within the grace window records a nested `context_tree_query`, chain compression defers the otherwise-eligible closed chain holding it wherever it would defer a chain holding a direct lookup.
  in-scope
- [ ] On the inclusive final user turn of the grace window, the script result qualifies for grace - the shared grace check (`inGraceRecoveryToolCallIds`) returns its key - just as a direct lookup of the same age does.
  in-scope
- [ ] On the first user turn past the grace window, the shared grace check returns neither the script result nor the direct lookup.
  in-scope
- [ ] With `recoveryGraceTurns` set to zero, the shared grace check returns neither the script result nor the direct lookup.
  in-scope
- [ ] The shared grace check does not return a script result with no recorded lookup.
  in-scope
- [ ] A later result with no recorded lookup that reuses the tool call ID of an in-grace script result under a different timestamp does not inherit grace: the shared grace check does not return it.
  in-scope

## Legs

### Leg: jjuraszek/pi-condense
branch: gh-44-codemode-recovery-grace
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `bun test src/`; typecheck `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove, never committed); the offline idle replay in Design, "Replay verification"; no paid eval; a plan file is `git rm`-ed before the branch finishes (`.pi/gauntlet-overrides.md`, "Plan retention")
Rules: AGENTS.md
Rules: README.md
Rules: PRUNING.md
Rules: eval/README.md
Rules: .agents/skills/release/SKILL.md
Rules: CHANGELOG.md
Rules: .pi/gauntlet-overrides.md
Rules: AGENTS.core.md
scope: none
design: owns every path in Design; the observable outcomes are the seven acceptance rows above.

## Design

### One rule, widened

`inGraceRecoveryToolCallIds` stays the single definition of "a recovery result still in its window". Its match gains one alternative. A message qualifies when it is a `toolResult` with a string `toolCallId` and either:

- `m.toolName === QUERY_TOOL_NAME` (today's rule, unchanged), or
- `Array.isArray(m.nestedCalls?.calls)` and some entry has `call?.name === QUERY_TOOL_NAME`.

The alternative is written inline in the existing condition. Key construction (`occKey(m.toolCallId, m.timestamp)` for a numeric timestamp, the bare ID otherwise), the user-turn count, the inclusive `nowUTG - seen <= graceTurns` boundary, and the empty set for `graceTurns <= 0` are unchanged.

The new alternative reads nothing else:

- not the outer tool name - any tool that records nested calls qualifies; `codemode` is the test subject (ticket: "any tool result whose recorded nested calls include a lookup");
- not the nested call's `status` or `arguments` - a failed or unfinished lookup counts, as a failed direct lookup counts today;
- not `nestedCalls.complete` - a truncated record earns grace only when the lookup name is in it. The `complete === false` clause of `isProtected` is not copied.

### Data flow

Pi attaches the nested-call record to the outer tool result. Both arrays the check receives carry it: the render context messages and the projected session branch. The check returns the script result's occurrence key, and every consumer behaves as it does for a direct lookup's key:

- `pruneMessages` phase 1 finds the key and returns the message verbatim instead of the stub;
- `selectEligible` (flush, manual compact, idle cleanup) finds the key in a closed chain's middle keys and defers that chain;
- `eval/replay/idle.ts` calls the same check on both paths;
- once more than `recoveryGraceTurns` user turns follow the result, the key drops out and the result is stubbed and its chain compressed as usual.

Grace covers the whole script result, including output from its other nested calls, because Pi does not record which part came from the lookup. The outer script call also keeps its arguments (the script source) unshrunk until its result is stubbed, because argument shrinking follows phase-1 stubbing (`src/pruner.ts:137-142,176`, `PRUNING.md:1180`). The window bounds that cost exactly as it bounds a direct lookup.

### Responsibilities

`src/recovery-grace.ts` owns the definition of a recovery result. `src/pruner.ts`, `src/chain-compressor.ts`, `src/chain-detector.ts`, `index.ts`, and `eval/replay/idle.ts` stay consumers of a key set and are not edited. `src/protected.ts` is not edited and no shared nested-call matcher is extracted.

### Moving parts

Remove: none.

Add:

- `src/recovery-grace.ts`: the second match alternative, and a header comment that names both kinds of recovery result (a direct lookup, and a tool result whose recorded nested calls include one) and states that the whole outer result is graced.
- `src/recovery-grace.test.ts`, `src/pruner.test.ts`, `src/chain-compressor.test.ts`: the new cases in Tests. No existing case is edited or removed.
- `PRUNING.md`, "What Pruning Does", recovery grace bullet: the window also applies to a tool result whose recorded nested calls include `context_tree_query` (a codemode script that made the lookup); the whole result is kept, including output of its other nested calls; the outer script call keeps its arguments until its result is stubbed; a record that does not name the lookup earns none.
- `doc/configuration.md`, `recoveryGraceTurns` row: the same scope in one clause.
- `src/commands.ts`, `recoveryGraceDescription`: both branches say recovered output "returned directly or inside a script".
- `CHANGELOG.md`: a `## [Unreleased]` section with a `### Fixed` entry ending `(#44)`.
- `doc/specs/2026-07-06-recovery-grace-window.md`: the supersession banner pointing here. The banner does not cite a "Decision" section of the gh-44 spec, which has none. Its text:

  ```markdown
  > **Superseded by:** [doc/specs/2026-11-18-gh-44-codemode-recovery-grace.md](./2026-11-18-gh-44-codemode-recovery-grace.md) - the "Decision" below on which results earn grace (direct `context_tree_query` output only) is superseded by the linked spec's "One rule, widened" section: direct lookups and tool results whose recorded nested calls name `context_tree_query` qualify for the same window.
  ```

### Replay verification

Two actions are named. The offline idle replay is free and local, makes no model or network call, and reads copies of the operator's private session files. The dependency install that prepares the base checkout is setup, not part of the replay, and may use the network. Approving this spec authorizes both for the whole flow - seed, rows, repairs, and finish - without per-step permission prompts. No paid action is named, so none runs.

- Runner: `npm run eval:replay -- idle <set dir> --out <out dir>`, with `--minutes` omitted and `PI_CODING_AGENT_DIR` left as found, so the operator's live `contextPrune` settings apply.
- Prerequisites: the loaded settings have pruning enabled (`enabled`), chain compression enabled (`chainCompression.enabled`), `pruneOn` other than `"on-demand"`, and `recoveryGraceTurns > 0` (observed: enabled, enabled, `"agent-message"`, 3). `eval/replay/idle.ts:142` skips every check when one of the first three fails, and at `recoveryGraceTurns` 0 the check returns nothing, so the replay cannot observe the change. A missing prerequisite ends automatic verification as "not applicable" (see Outcomes).
- Sessions root: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions`.
- Selected directories: every directory under the root that directly holds a `.jsonl` file with a `toolResult` entry whose `message.nestedCalls.calls[].name` includes `context_tree_query` (`rg -l` prefilter, `jq` confirmation).
- Sets: "affected" holds the confirmed files; "control" holds every other `.jsonl` file in the selected directories. Each arm gets its own copy of each set: four directories of regular-file copies named `<directory index>-<file name>`, created with `mktemp -d` outside every checkout, all made before any session is opened. No symlinks: `SessionManager.open` (`eval/replay/idle.ts:133`) opens with persistence and can rewrite a file it migrates or finds empty, and a write through a link would land in the operator's original.
- Code under test: "base" is a detached checkout of `git merge-base HEAD origin/main` (`git worktree add --detach` into a `mktemp -d` path, dependency install, removed after the run); "candidate" is the home worktree.
- Dependencies: both arms run on identical resolved dependency trees. `package.json` ranges float (`^1.5.1`) and no lockfile is tracked, so a fresh install can resolve differently from the home install. The installed `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` versions are recorded for every invocation; a difference between the arms' resolved trees invalidates the comparison, and the runs repeat after the base install is aligned to the candidate's resolved versions.
- Settings: the normalized `contextPrune` settings the runner loads are recorded for every invocation (`eval/replay/idle.ts:189` reloads them each time); a difference between any two invocations invalidates the comparison and all four runs repeat.
- Runs: base and candidate, each on its own copy of each set, four in total, each with its own `--out` directory outside every checkout.
- Stability: size and mtime of every source file, read with a dereferencing API (Node `statSync`), are recorded before the copies are made and compared after the last run; a source that changed is removed from its set in both arms and that set's two runs repeat.
- Pass, control set (regression guard, and the overuse guard for results with no recorded lookup): `sessionsRead`, `sessionsSkipped`, `returnsFound`, `returnsChecked`, `violations`, `pointerResultsChecked`, `estimatedTokensRemoved`, and `medianPromptShareRemoved` are identical between base and candidate.
- Pass, affected set (invariants and exercised path): both runs exit 0 with `violations` 0 and `sessionsSkipped` 0; `sessionsRead`, `returnsFound`, and `returnsChecked` are equal between the arms; `returnsChecked` is greater than zero; a witness is recorded.
- Witness: at least one checked idle return in the affected set where a tool result whose recorded nested calls name `context_tree_query` is inside its window, and either its rendering differs between the arms (stub in base, verbatim in candidate) or its otherwise-eligible closed chain is eligible in base and deferred in candidate. The witness is observed per return and never inferred from an aggregate token delta, because added retention can cancel to a zero delta. It is recorded as counts only (checked returns, returns with a render witness, returns with a chain witness) by a throwaway script kept in the temp directories and never committed, which reads the copies through each arm's own modules; `eval/replay/idle.ts` is not edited.
- Outcomes: with every condition met, the replay is reported as passed. With a missing prerequisite ("not applicable"), or affected-set `returnsChecked` 0 or no witness ("not exercised"), automatic verification stops and the operator is told which; the flow does not report a replay pass and does not silently finish on unit tests alone. With a failed pass condition, the flow stops and reports the aggregates of all four runs for operator review; no condition is amended mid-run.
- Reported to the operator: the eight aggregate fields per run, the witness counts, and the signed base-minus-candidate `estimatedTokensRemoved` on the affected set, labeled as the change in incremental idle-cleanup savings. That delta is a diagnostic with no pass condition and no threshold. It excludes the added phase-1 retention: each arm measures its own pre-cleanup render minus its post-cleanup render (`eval/replay/idle.ts:149,166,172-174`), so results newly kept verbatim enlarge both and cancel out. A correct deferral can move it either way, because literal chain compression can be larger than the stubs it replaces. Session contents, file names, and directory names never leave the temp directories; the temp directories are deleted after reporting.

Overuse is guarded by the exact-key unit tests (Tests, "Overuse guard") and by control-set equality, not by the affected-set delta.

Eval decision: not needed. No eval job, idle twins included, loads codemode or a `nestedCalls` fixture, so the paid comparisons cannot observe the change, and the baseline was captured on Pi 1.5.0 against an installed 1.5.2. The replay shows the widened check ran on real sessions with the invariants intact; it does not measure the added retention.

## Errors and edge cases

- Malformed record: `nestedCalls` missing, null, or not an object; `calls` missing or not an array; a null entry; an entry without `name` or with a non-string `name`. None earns grace and none throws.
- Exact name only: the lookup name inside another nested call's `arguments`, in the result text, or as a near-miss nested name (`context_tree_query2`, `Context_Tree_Query`) earns nothing.
- Incomplete record (`complete: false`): earns grace when the lookup name is in `calls`, none when it is not.
- Lookup dropped past the recorder's 256-call cap: its name is not recorded, so the check does not return the result. That result is already kept verbatim by incomplete-record protection.
- Failed or unfinished nested lookup: counts.
- Several nested lookups in one result: one key, one window, fixed at the outer result's position. Nothing resets it.
- A result that is both a direct lookup and records a nested one: one key.
- No numeric timestamp: the bare tool call ID is the key, as for a direct lookup today. Reuse of an ID without a timestamp or with an equal timestamp keeps sharing grace.
- Reused ID under a different timestamp with no recorded lookup: a different occurrence key, not returned (AC row 7).
- Protection and grace: the check does not consult protection. A protected result stays verbatim through `isProtected` before grace is read (`src/pruner.ts:134-139`); its key is returned by the check exactly as a direct lookup's key is when the lookup tool is listed in `protectedTools`.
- A chain compressed before this change stays compressed; the check is prospective and reconstructs nothing.
- Capture, summarization, and indexing are unchanged: the script result is still summarized and indexed, and is stubbed after the window.

## Tests

- AC 1: a summarized `codemode` result naming the lookup renders verbatim in-window while a summarized `codemode` result with no recorded lookup beside it renders as a stub - `src/pruner.test.ts`
- AC 2: with real `detectChains` and the real check, the closed chain holding the script result is deferred while a neighbor closed chain is eligible - `src/chain-compressor.test.ts`
- AC 2, expiry: the same chain is eligible once the window has passed - `src/chain-compressor.test.ts`
- AC 3: on the inclusive final user turn the set holds both the script key and the direct key - `src/recovery-grace.test.ts`
- AC 4: one user turn later the set holds neither - `src/recovery-grace.test.ts`
- AC 5: with `graceTurns` 0 the set is empty for both - `src/recovery-grace.test.ts`
- AC 6: a script result whose record names only other tools is not returned - `src/recovery-grace.test.ts`
- AC 7: `X@11` with a recorded lookup is returned and a later `X@20` without one is not - `src/recovery-grace.test.ts`
- Outer tool name is not restricted: a non-`codemode` result naming the lookup is returned - `src/recovery-grace.test.ts`
- Malformed records earn nothing and do not throw - `src/recovery-grace.test.ts`
- Incomplete record: returned with the name, not returned without it - `src/recovery-grace.test.ts`
- Failed nested lookup (`status: "error"`) is returned - `src/recovery-grace.test.ts`
- Several nested lookups yield one key - `src/recovery-grace.test.ts`
- No timestamp: the bare ID is the key - `src/recovery-grace.test.ts`
- Overuse guard: a mixed array (a direct lookup, a scripted lookup, and every near-miss and malformed shape above) returns exactly the two real keys - `src/recovery-grace.test.ts`
- Regression guard: direct-lookup grace, protection precedence, and reused-ID isolation - existing cases in `src/recovery-grace.test.ts`, `src/pruner.test.ts`, `src/chain-compressor.test.ts`, unmodified
- Lookup dropped past the 256-call cap - none: indistinguishable from an incomplete record without the name, covered above
- Already-compressed chain stays compressed - none: no code path changes; the check is only read for eligibility
- Regression on real sessions, overuse on results with no recorded lookup (control-set equality), and exercised-path evidence (affected-set invariants and witness) - the replay in Design, "Replay verification"
- Wording in `PRUNING.md`, `doc/configuration.md`, and `recoveryGraceDescription` - none: prose

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` "What Pruning Does" recovery grace bullet (major definitions: what counts as a recovery result); `doc/configuration.md` `recoveryGraceTurns` row (operations / tunable parameters); `CHANGELOG.md` Unreleased (major procedures / conventions: release discipline)
- Derived / memory docs invalidated: none

## Out of scope

- Summary sampling and nested error reporting (ticket).
- Per-inner-call recovery references (ticket).
- ID reuse without a timestamp or with an equal timestamp: keeps sharing grace (ticket).
- Any edit to `src/protected.ts`, or a shared nested-call matcher.
- Restricting the match to outer tool `codemode`.
- Grace for an incomplete record that does not name the lookup.
- Reconstructing chains compressed before this change.
- The paid seven-case eval, the paid idle twins, a baseline recapture, and a live smoke session.
- A failure threshold on how far `estimatedTokensRemoved` drops on the affected set, or any pass condition on the sign of that delta.
