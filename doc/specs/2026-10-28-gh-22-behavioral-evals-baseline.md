# Behavioral evals and a baseline for context retention

**Ticket:** [jjuraszek/pi-condense#22](https://github.com/jjuraszek/pi-condense/issues/22)
**Goal:** Add a hands-free, paid behavioral eval (`npm run eval`) that drives the real extension through the pi SDK on a synthetic seven-scenario corpus, scores downstream behavior with mechanical checks plus a frozen LLM judge, and commit a baseline report per pinned summarizer so every later summarization change is measured against it.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Date:** 2026-10-28
**Status:** draft

## Problem

The summarizer is the one component where a prompt or input change silently changes context quality, and nothing measures that today. `src/summarizer.test.ts` mocks the model with a fixed `- summary` string and asserts on request shape; `src/batch-capture.ts:221-223` clips every tool result to a fixed 4000-char head and tail before the model sees it; `bun test src/` is the only test command in `package.json` and both CI workflows (`.github/workflows/test.yml`, `release.yml`). A regression in what a summary retains, or in whether the downstream agent recovers the original through `context_tree_query`, is invisible until a user notices.

Verified premises:

- The SDK can seed a conversation (`SessionManager.inMemory(cwd?, options?, entries?)`, `session-manager.d.ts:386`) and load `index.ts` as an extension (`DefaultResourceLoader({ additionalExtensionPaths })`, `examples/sdk/06-extensions.ts`). `DefaultResourceLoader` requires `cwd` and `agentDir` (`resource-loader.d.ts:70-74`); with `cwd` at the repo it discovers `AGENTS.md` into the system prompt unless `noContextFiles` (`resource-loader.js:116`), and it merges discovered extensions, skills, and prompts (`resource-loader.js:130-210`). `createAgentSession` takes `model` as a `Model` object, not an id string (`sdk.d.ts:11`), accepts a caller-supplied `modelRuntime` (`sdk.d.ts:16`), and does not emit `session_start`; `session.bindExtensions(...)` does (`agent-session.js:2660-2682`, `sdk.js:295-328`). `noTools: "builtin"` suppresses builtin tools only; other loaded extensions' tools stay eligible (`sdk.js:149-162`).
- On `session_start` the extension loads its config (`index.ts:796-798`) and rescans the branch for uncaptured tool calls (`index.ts:816-823`); `/pruner now` flushes them (`src/commands.ts:1057-1090`) and exits early when pruning is disabled (`src/commands.ts:1057-1061`). `getBranch()` walks `parentId` and returns only the leaf when parents are null (`session-manager.js:1062-1073`); capture reads assistant content blocks of `type === "toolCall"` by `id` and matches `toolResult.toolCallId` (`src/batch-capture.ts:170-176`).
- `getAgentDir()` reads `process.env.PI_CODING_AGENT_DIR` on every call (`config.js:491-496`); `settingsPath()` resolves lazily (`src/config.ts:19-24`); `DefaultAuthStorage` defaults to `<agentDir>/auth.json` (`auth-storage.js:289`); `normalize()` fills unset `contextPrune` keys from the running revision's `DEFAULT_CONFIG` (`src/config.ts:38-40`). The env var is process-global, so concurrent in-process jobs with different agent dirs race.
- `flushPending` writes a `context-prune-flush-metrics` entry for every outcome, including `empty`, `skipped-trivial`, `skipped-oversized`, and errors (`index.ts:255-266`, `src/types.ts:748`); trivial batches (under `minBatchChars`, default 2000, `src/types.ts:570`) get no summary and no index entry. Summary `details` carry `toolCallRefs` / `toolNames` / `turnIndex` / `timestamp` only (`src/types.ts:719-724`); `StatsAccumulator.add` folds `usage.cost?.total ?? 0` (`src/stats.ts:46`); no `context-prune-*` entry stores per-call usage or the model that answered. `resolveModel` falls back to `ctx.model` with a `ctx.ui.notify` warning only (`src/summarizer.ts:49-76`), which is a no-op under the SDK's `noOpUIContext`. The summarizer calls `ctx.modelRegistry.streamSimple(...)` (`src/summarizer.ts:173`), so a runtime passed to the session is the one observable boundary for summarizer calls.
- `context_tree_query` tells the model to pass `t<N>` short refs from the summary (`src/query-tool.ts:24-27`); bare raw ids also resolve (`src/indexer.ts:302`); a missing ref returns a textual not-found block (`src/query-tool.ts:109-113`); each returned record is a `## toolRef: <label>` block with `Tool:` and `Args:` (`src/query-tool.ts:47-60`). The short-ref map is `shortId -> toolCallId` on the `context-prune-index` entry and summary `toolCallRefs` (`src/types.ts:719-724`, `src/indexer.ts:201-214`).
- `anthropic/claude-opus-5-5` declares `supportsTemperature: false` and `supportsMidConvoEffort: true`; `anthropic-messages.js:958-964` omits temperature for it. pi-ai's normalized `Usage` initializes missing counts to zero and derives cost from catalog rates (`anthropic-messages.js:381-394, 492-502`, `openai-responses-shared.js:505-520`).
- This repo lands most changes as direct commits to `main` (`.pi/gauntlet-overrides.md`: "there is no PR gate on `main`"; `git log --oneline -15 main` shows no merge commits since PR #1).

Observed, not fixed here: `AGENTS.md` cites `pi-ai/dist/providers/transform-messages.js`; the file is `pi-ai/dist/api/transform-messages.js`. Adjacent repair, out of this ticket's scope.

Unverified: the SDK seeding-and-extension path was source-inspected, not executed; whether pi-ai exposes provider-reported cost separately from catalog-estimated cost at the runtime boundary is unknown until the observer is validated offline (Open questions). Both are carried as design clauses: an offline lifecycle test with a stub runtime runs before any paid job, and cost provenance renders `estimated` or `unavailable` when provider-reported cost cannot be established.

Framing: kept - checked the summarizer prompts, clipping, the `session_start` rearm and `/pruner now` path, the config source, the SDK session and tool surface, `package.json` and CI, the stats cost path, and pi-gauntlet's `eval/` as prior art (no dependency). The mid-result-fact scenario is measured on recovery, not direct retention, because clipping removes the fact from the summarizer input by construction.

User constraints from the questionary: fully hands-free (one command, no human step); the LLM judge decides judged cases and its reason appears in the report; the baseline is committed in this branch (no follow-up ticket); run instructions are clear for a human and an agent; `AGENTS.md` carries the rule for deciding whether a change needs an eval run; no private repo data in fixtures or committed artifacts; runs are parallel.

## Acceptance criteria

Ticket jjuraszek/pi-condense#22, Acceptance criteria, rows verbatim:

- [ ] A checked-in synthetic corpus defines inputs and expected downstream behavior for: a decisive fact in the middle of a long tool result; an unverified hypothesis; an explicitly disproved explanation; an unsuccessful fix that does not disprove its hypothesis; repeated attempts on one task among unrelated work; a human correction followed by a topic change; and a human approval boundary.
  in-scope
- [ ] Running the corpus exercises actual model-generated summaries, pruned context, and a subsequent assistant response or action; the report records each case's expected behavior, observed behavior, and pass/fail result rather than accepting summary format alone.
  in-scope
- [ ] For cases that require original evidence, the run records whether recovery returned the correct source and whether the assistant's subsequent answer used it; a correct-looking answer without the required evidence does not pass that case.
  in-scope
- [ ] Running a baseline against the unchanged implementation produces a retained report linked from the eval documentation, identifying the code revision, corpus revision, model and pipeline settings, repetitions, scoring method, and per-case results, including failures.
  in-scope
- [ ] Each run records summarizer and downstream input/output usage, elapsed time, and cost where available; missing provider measurements are explicitly reported as unavailable rather than zero.
  in-scope
- [ ] Repeating the documented invocation with a candidate revision produces a comparison against that baseline artifact on the same corpus and model settings; the report names the intended experimental change, holds unrelated pipeline settings constant, and shows per-case behavior changes and measured overhead.
  in-scope
- [ ] The documented workflow requires the baseline before evaluating either select-classify-summarize changes or recent-dialogue enrichment, without requiring either product change to complete this ticket.
  in-scope
- [ ] The documented paid-eval invocation is explicit, and running the existing unit-test command does not silently start paid model calls.
  in-scope

Row readings fixed as Design clauses: "expected behavior" in row 2 is the scenario's `expected` sentence (judged cases) or its mechanical requirement rendered as a sentence, written into the retained report per case; "observed behavior" is, per repetition, the reply excerpt (first 600 chars), the ordered tool-call list with each `context_tree_query` result's outcome, the pass/fail/error verdict, and the failed check name or judge reason - all written into the retained report, with full replies, summaries, judge prompts, and observer logs in the temp run dir. Row 3's "recovery returned the correct source" is observed on the `context_tree_query` tool result (the returned `## toolRef` block), not on the call arguments alone. "Corpus revision" in row 4 is the git SHA of the clean tree that ran plus a content hash over `eval/scenarios/`. "Intended experimental change" in row 6 is the `--change "<text>"` flag, required with `--compare`. Row 7's workflow rule lives in `AGENTS.md`; its observable is the `eval:` line in the commit body of the change.

## Design

### Layout

```
eval/
  README.md            # human/agent contract: what, why, how to run, how to read, when to re-baseline
  run.ts               # CLI entry: parse flags, preflight, spawn one subprocess per job, write report, exit code
  config.ts            # pinned ids, full literal pipeline settings, subject prompt, run constants (below)
  scenario.ts          # Scenario type + seedEntries(history) -> FileEntry[]
  session.ts           # subprocess entry for one job: build runtime + session, bind, flush, probe, collect
  observer.ts          # non-mutating ModelRuntime wrapper: records every model call (model, status, raw usage, context)
  judge.ts             # mechanical checks + judge call
  report.ts            # render markdown, compare with baseline
  scenarios/           # seven files, one per case
    mid-result-fact.ts
    unverified-hypothesis.ts
    disproved-explanation.ts
    failed-fix-not-disproof.ts
    repeated-attempts-among-unrelated.ts
    correction-then-topic-change.ts
    approval-boundary.ts
  baseline/
    claude-haiku-5-5.md
    gpt-6-luna.md
  *.test.ts            # offline unit tests (stub runtime, no network), run by `bun test eval/`
```

Add: everything under `eval/`; `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`); `AGENTS.md` "Behavioral eval" section, Layout and Testing updates; `README.md` routing row; `CHANGELOG.md` `## [Unreleased]` entry. Remove: none. `src/` is untouched. `eval/` imports nothing from `src/`; it reaches the extension only through `index.ts` as pi would, and observes model calls only through the `ModelRuntime` it hands to the SDK.

### Pinned configuration (`eval/config.ts`)

| Constant | Value |
|---|---|
| `SUBJECT_MODEL` | `anthropic/claude-sonnet-5-5` |
| `SUBJECT_SYSTEM_PROMPT` | fixed string in `config.ts` (a short synthetic coding-assistant prompt; no repo material) |
| `SUBJECT_THINKING_LEVEL` | `medium`, passed explicitly |
| `SUMMARIZER_MODELS` | `anthropic/claude-haiku-5-5`, `github-copilot/gpt-6-luna` |
| `JUDGE_MODEL` | `anthropic/claude-opus-5-5` |
| `JUDGE_PROMPT` | fixed system prompt + rubric in `judge.ts`; its sha256 is `judgePromptHash` |
| `RUNS_PER_CASE` | 3 |
| `DEFAULT_CONCURRENCY` | 8 (override `EVAL_CONCURRENCY`) |
| `PIPELINE_SETTINGS` | full literal `contextPrune` block: every key written, values copied from `DEFAULT_CONFIG` (`src/types.ts`) at authoring time with `enabled: true` and `summarizerModel: <summarizer>`; never imported from `src/`; its sha256 (with `summarizerModel` blanked) is `settingsHash` |
| `RETRY_POLICY` | 2 retries, backoff 2s then 8s, only on HTTP 429 or transport errors |

Writing every key means a candidate revision that changes a `DEFAULT_CONFIG` default does not shift the pipeline under test; a default change is evaluated by editing the literal and re-baselining.

Comparison key = `{ SUBJECT_MODEL, SUBJECT_SYSTEM_PROMPT hash, SUBJECT_THINKING_LEVEL, summarizer, JUDGE_MODEL, judgePromptHash, settingsHash, corpusHash, RUNS_PER_CASE }`. A baseline is valid only for this exact key; the report header records it plus the installed `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` versions (recorded for provenance, printed as a warning on mismatch, not a refusal), and `--compare` refuses any key mismatch with both headers shown.

The judge is frozen by model id, prompt, and rubric identity, not by determinism: the pinned provider omits temperature for `claude-opus-5-5`, so no temperature is passed and sampling variance is expected; `RUNS_PER_CASE` exists for that reason.

### Scenario shape (`eval/scenario.ts`)

```ts
type Scenario = {
  id: string;                       // file stem
  title: string;
  tests: string;                    // one paragraph for README and run header: what this case checks and why
  history: SeedTurn[];              // user / assistant(toolCalls) / toolResult, deterministic fixtures
  probe: string;                    // user turn sent after pruning
  mechanical: {
    contains?: string[];            // objective literals (values, identifiers) that must appear in the reply
    recovers?: { id: string; evidence: string }[];
                                    // seeded tool-call ids whose original must be recovered; `evidence` is a
                                    // literal that the returned source block must contain
  };
  judged?: {
    oracle: string;                 // the concrete synthetic facts the judge may rely on: the hypothesis text,
                                    // the refuting observation, the failure reason, the corrected value and the
                                    // old one, the approved step and the unapproved one - as the fixture states them
    expected: string;               // one sentence: the behavior that passes
  };
};
```

`seedEntries(history)` builds the `FileEntry[]` for `SessionManager.inMemory` as a real traversable session: a session header entry, unique entry ids with a `parentId` chain from the first message to the leaf, complete `AssistantMessage` objects (`role`, `content`, `usage`, `stopReason`, `model`, `provider`, `api`, `timestamp` per `pi-ai/dist/types.d.ts`), `toolCall` content blocks with `id`, `name`, `arguments`, and `toolResult` messages whose `toolCallId` links the call, so `getBranch()` sees every turn, `insertSyntheticToolResults` never fires, and batch capture finds every call. Tool-call ids are fixed strings per scenario (`call_<scenario>_<n>`). Fixture tool names and paths avoid `PIPELINE_SETTINGS.protectedPaths` (`**/skills/**/*.md`, `**/gauntlet-overrides.md`). Every scenario's capturable tool-result batch exceeds `PIPELINE_SETTINGS.minBatchChars` by at least 50% after agent-message grouping, so each case takes the summarized path and never the trivial or oversized skip; a unit test asserts eligibility per scenario against the literal settings. Fixtures are invented end to end: a fictional project (`orbital-ledger`), fictional paths under it, fictional error text. No real names, hosts, emails, keys, or `/Users/` paths.

The seven cases and their scoring:

| Case | Evidence-required | Mechanical | Judged |
|---|---|---|---|
| mid-result-fact: a 12k-char fixture file with the decisive value at ~6k chars; probe asks for the value | yes | `recovers` the file read with the value as evidence + `contains` the value | no |
| unverified-hypothesis: assistant proposed a cause, never checked it; probe asks what is known | no | - | oracle: the proposed cause and that no check ran; expected: reply presents the cause as unverified, not as fact |
| disproved-explanation: a hypothesis, then a tool result refuting it; probe asks for the cause | no | - | oracle: the hypothesis and the refuting observation; expected: reply names that explanation as ruled out and cites the refutation |
| failed-fix-not-disproof: a fix attempt failed for an unrelated reason; probe asks whether the hypothesis still stands | no | - | oracle: the hypothesis, the fix, the unrelated failure reason; expected: reply keeps the hypothesis open and distinguishes the failed attempt from disproof |
| repeated-attempts-among-unrelated: three attempts on task A interleaved with unrelated task B; probe asks what was tried on A | yes | `recovers` the three A attempts with each approach's identifier as evidence + `contains` each identifier | no |
| correction-then-topic-change: user corrected the assistant, then moved on; probe returns to the corrected topic | no | `contains` the corrected value | oracle: old value, corrected value, the correction turn; expected: reply uses the corrected value and does not assert the old one (quoting it as rejected is fine) |
| approval-boundary: user approved step 1 only; probe asks the assistant to proceed | no | - | oracle: step 1, step 2, the approval wording; expected: reply performs or offers step 1 and asks before step 2 |

Literal gates are reserved for objective identifiers and evidence; whether a reply asserts, quotes, negates, or corrects a fact is the judge's call against the oracle, so a reply like "use 42; my earlier 24 was wrong" is not failed mechanically.

Row 3's "recovery returned the correct source" and "answer used it", per seeded id in `recovers`: a `context_tree_query` call in the trace names that id, either raw or as a `t<N>` alias resolved through the run's `context-prune-index` short-ref map; its tool result contains a `## toolRef` block for that id whose text contains `evidence` and is not a not-found block; and that call completes before the final assistant text. Then `contains` on the reply. A hit without the value in the reply fails; the value without a successful hit fails; a call that returns not-found or a different source fails.

### One job (`eval/session.ts`)

`run.ts` spawns `bun eval/session.ts` once per job as its own subprocess (scenario, summarizer id, run index, paths as arguments), so each job owns its process environment. Steps inside the subprocess:

1. Job dir from `mktemp -d` (created by `run.ts`, passed in) with `agent/settings.json` holding `PIPELINE_SETTINGS` for this summarizer and an empty `cwd/` subdirectory. `PI_CODING_AGENT_DIR=<job>/agent` is set in the subprocess environment by `run.ts` before spawn. No credential file is copied into the job dir; nothing under it is committed.
2. `const runtime = observe(await ModelRuntime.create({ authPath: <operator agentDir>/auth.json, modelsPath: <operator agentDir>/models.json }))` where the operator agent dir is `getAgentDir()` as resolved by `run.ts` before any override and passed explicitly. `observe` (`eval/observer.ts`) wraps `streamSimple` and `completeSimple` without changing their behavior and records per call: `model.provider/model.id`, the `context` passed, terminal status (`ok` / `error: <message class>`), the returned `AssistantMessage.usage` as returned by pi-ai (no `?? 0`), elapsed ms, and cost provenance (`provider` when pi-ai carries a provider-reported cost, `estimated` when it is derived from catalog rates, `unavailable` when neither; how pi-ai distinguishes the first two is the Open question below). Credentials never appear in observer records, logs, or artifacts.
3. `new DefaultResourceLoader({ cwd: <job>/cwd, agentDir: <job>/agent, additionalExtensionPaths: [<repo>/index.ts], noContextFiles: true, <loader options that disable skills, prompt templates, and discovered extensions> })`, `await reload()`. The only extension loaded is `index.ts`.
4. `createAgentSession({ cwd, agentDir, model: runtime.getModel("anthropic", "claude-sonnet-5-5"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(cwd, undefined, seedEntries(history)), noTools: "builtin", systemPrompt: SUBJECT_SYSTEM_PROMPT, thinkingLevel: SUBJECT_THINKING_LEVEL })`, then `await session.bindExtensions(...)` with extension load and `session_start` errors captured; any error is `error: extension`. Assert the effective tool list is exactly `[context_tree_query]` and the effective system prompt equals `SUBJECT_SYSTEM_PROMPT` plus fixed runtime material; otherwise `error: isolation`.
5. `await session.prompt("/pruner now")`. Then prove summarization: the branch has a `context-prune-flush-metrics` entry with `outcome: "summarized"` and `processedBatches >= 1`; every seeded tool-call id of the scenario appears in a `context-prune-index` entry or summary `toolCallRefs`; the observer recorded at least one call whose model is the pinned summarizer with status `ok`. Otherwise `error: no flush`. Any observed summarizer-phase call answered by a model other than the pinned summarizer is `error: summarizer-fallback`; a terminal summarizer call error is `error: summarizer`.
6. `await session.prompt(probe)`. From the observer, take the subject's first call context and assert the seeded tool results are replaced by stubs (the raw fixture text is absent, the summary and stub text are present); otherwise `error: not pruned`. Collect the final assistant text, the ordered tool calls with their results, subject usage (from the observer's subject calls), summarizer usage (from the observer's summarizer calls, aggregated with `unavailable` propagated when any call lacks the field), and wall time per step.
7. `dispose()`; write `job.json` (everything collected plus the observer log) into the job dir; `run.ts` keeps the run dir until the run ends and prints its path.

Output: `{ reply, toolCalls: [{ name, arguments, result, index }], recovery: [{ id, outcome: "hit" | "not-found" | "wrong-source" | "no-call" }], usage: { subject, summarizer }, costProvenance, elapsedMs: { flush, probe, total }, attempts, status: "ok" | "error", errorReason? }`.

### Scoring (`eval/judge.ts`)

Mechanical checks run first; any failure sets `fail` with the failed check named (`contains:<literal>`, `recovers:<id>:<outcome>`); no judge call. A `judged` case that passes mechanical calls the judge once: `runtime.getModel("anthropic", "claude-opus-5-5")` through the same observed `ModelRuntime` and `completeSimple`, `JUDGE_PROMPT` as system prompt, no temperature, input `{ oracle, expected, probe, reply, toolCalls }` - never the raw fixture history, which the oracle replaces - and requires JSON `{ pass: boolean, reason: string }`. The rubric tells the judge to score assertion versus quotation, negation, and correction against the oracle and to fail any claim the oracle does not support. Unparseable output retries once, then `error: judge`.

### Orchestration and output (`eval/run.ts`, `eval/report.ts`)

Preflight, before any job: refuse if `git status --porcelain` is non-empty (paid runs execute a committed tree so the recorded SHA identifies what ran); build the same observed `ModelRuntime` the jobs use and resolve every pinned id through it; a missing or unauthenticated id aborts with the id and `pi --list-models` named, no partial output.

Jobs = scenarios x `RUNS_PER_CASE` x selected summarizers, each a subprocess, run through a bounded pool of `DEFAULT_CONCURRENCY`. A job whose terminal failure is HTTP 429 or a transport error is retried per `RETRY_POLICY` with a fresh job dir; attempts and the added elapsed time are recorded on the job and in the header; after exhaustion the job stays `error: provider`. Judge-parse, summarizer, fallback, isolation, and no-flush errors are never retried.

Flags: `--compare --change "<text>"` (default mode; `--change` required), `--baseline`, `--summarizer <id>` (restrict to one), `--runs <n>` (override, recorded in header; `--baseline` requires the pinned value). The runnable examples are `npm run eval -- --change "<what changed>"` and `npm run eval -- --baseline`; bare `npm run eval` prints both and exits non-zero.

Run header (printed first and written to the report): what the eval is in two sentences, the comparison key with each value literal, `@earendil-works/pi-coding-agent` and `pi-ai` versions, git SHA, date, scoring method (mechanical gate + judge on judged cases, judge prompt hash), retry counts, and estimated cost and duration from the committed baseline or `unavailable (no baseline yet)`.

Report per summarizer: header, then one section per case: the `tests` paragraph; expected behavior (oracle and `expected`, or the mechanical requirement as a sentence); a verdict line `passes n/3, errors m`; then per repetition: verdict, failed check or judge reason (always present for a fail), recovery outcome per seeded id, the reply excerpt (first 600 chars), the tool-call list (`name(arguments) -> outcome`), summarizer tokens in/out, subject tokens in/out, elapsed, cost with provenance. A totals table closes the report. Any usage field a provider did not return renders `unavailable`, never `0`; a cost that is catalog-estimated renders `<value> (estimated)`. Full replies, summaries, judge prompts, and observer logs stay in the temp run dir, whose path is printed at the end.

`--baseline`: exits non-zero and writes nothing if any job errored; otherwise overwrites `eval/baseline/<summarizer>.md` and exits 0 even when cases fail (a failing case is a finding). `--compare`: writes the candidate report to the temp dir and prints its path, reads the committed baseline, aborts on comparison-key mismatch (including corpus hash: a scenario edit needs a re-baseline), then prints the `--change` text, one row per case with `baseline n/3 -> candidate n/3` and a `=`, `+`, `-` marker, per-repetition changes in failed check / judge reason / recovery outcome, token and elapsed deltas as overhead, errored jobs apart, and a summary block `REGRESSION CANDIDATE: <case> <b>/3 -> <c>/3` for every case whose pass count dropped. Exits non-zero on any regression candidate or error. A one-pass drop over three repetitions is a candidate, not a proven degradation: the README documents sampling variance and the confirmation procedure (re-run the same `--compare` once, keep both run dirs, treat two consecutive drops as a regression).

### Documentation and workflow rule

`eval/README.md` states: purpose (measure what the subject agent still does right after real summarization and pruning), the comparison key and why it is frozen (identity, not determinism), a table of the seven cases from each scenario's `tests` paragraph, the exact commands `npm run eval -- --change "<what changed>"` and `npm run eval -- --baseline`, how to read a report section, sampling variance and the confirmation re-run, when to re-baseline (any change to the comparison key, including a scenario or the judge prompt), cost and duration from the committed baseline, and that the two baselines were produced in this branch at the recorded SHA.

`AGENTS.md` gains a "Behavioral eval" section: a change under `src/summarizer*.ts`, `src/batch-capture.ts`, `src/chain-*.ts`, `src/pruner.ts`, `index.ts` prune hooks, or the stub text runs `npm run eval -- --change "<what changed>"` before landing, and the commit body of that change carries either the comparison result line or `eval: not needed - <paths touched>` (a PR body may repeat it; the commit body is the required record, for direct commits and PRs alike); select-classify-summarize and recent-dialogue enrichment are named as changes that require this baseline first. Layout gains `eval/`; Testing names `bun test eval/` as offline and outside the release gate.

### Baseline production in this branch

Sequence: commit the harness and corpus; with a clean tree, run `npm run eval -- --baseline` once per summarizer on the unchanged `src/` at that SHA; commit both reports as the next commit. A failing case is a finding recorded in the report, not a reason to adjust scenarios to pass. If a job errors after retries, fix the harness, commit, and re-run; never commit a baseline with errors. If the SDK integration cannot drive `index.ts`, that blocks baseline production and is fixed in the harness; no alternative measurement path is substituted.

## Errors and edge cases

- Dirty working tree at preflight: abort, print `git status --porcelain`, write nothing.
- Pinned id not in registry or not authenticated (copilot login absent): abort before any job, name the id and the check, write nothing.
- Extension load or `session_start` error: `error: extension`. Effective tools or system prompt differ from the pinned set: `error: isolation`.
- Flush produced no `summarized` outcome, or a seeded id is missing from the index: `error: no flush` (a pass would measure raw context). Subject input after pruning still carries raw fixture text: `error: not pruned`.
- Summarizer call fails inside the extension: `error: summarizer`; a summarizer-phase call answered by a model other than the pinned summarizer (sticky-outage fallback to the subject): `error: summarizer-fallback`. Neither is `fail`; `--baseline` refuses, `--compare` lists them apart from regressions and exits non-zero.
- Judge output not `{ pass, reason }` JSON: one retry, then `error: judge`.
- Provider 429 or transport error: retried per `RETRY_POLICY` with attempts recorded; then `error: provider`.
- Missing usage field or cost: `unavailable` in that cell; catalog-derived cost: `(estimated)`.
- `--compare` against a baseline with a different comparison key or run count: abort with both headers shown.
- `--baseline --summarizer <id>`: overwrites only that file.
- `--baseline --runs <n != 3>`: rejected.
- Mid-result-fact fixture must exceed 8000 chars with the fact outside head and tail; a unit test asserts the position.
- Every write outside `eval/baseline/` lands under one `mktemp -d`; credentials are read from the operator's agent dir and never copied, logged, or written.

## Tests

`bun test src/` is unchanged. `bun test eval/` (also `npm run test:eval`) is offline (stub runtime, no network), not part of `npm test`.

- Row 1 corpus coverage: seven scenario files load, ids unique, each has `tests`, `probe`, and `mechanical` or `judged` with `oracle` - `eval/scenarios.test.ts`
- Row 1 fixture hygiene: no `/Users/`, `@`, `sk-`/`ghp_`-style tokens, or real hostnames in fixtures; no path matching `protectedPaths` - `eval/scenarios.test.ts`
- Row 1 mid-fact position outside the 4000/4000 window - `eval/scenarios.test.ts`
- Row 2 eligibility: each scenario's capturable batch exceeds `minBatchChars` by 50% under the literal `PIPELINE_SETTINGS` - `eval/scenarios.test.ts`
- Seed builder: header entry, parent-linked chain reaches every turn through `getBranch()`, complete `AssistantMessage` fields, every `toolCall` block has a `toolResult` with matching `toolCallId`, ids follow `call_<scenario>_<n>` - `eval/session.test.ts`
- Lifecycle offline: real SDK session with the stub runtime (fixed summary text) loads only `index.ts`, fires `session_start` with the extension enabled, `/pruner now` yields `outcome: summarized` and index coverage, the tool list is exactly `[context_tree_query]`, the subject's first probe context has stubs and no raw fixture text; a stub runtime returning `skipped-trivial`-sized batches yields `error: no flush`; a disabled-settings dir yields `error: no flush` - `eval/lifecycle.test.ts`
- Observer: records model, status, raw usage with absent cost left absent, and classifies a call answered by the subject model in the summarizer phase as `error: summarizer-fallback` - `eval/observer.test.ts`
- Row 2 / row 3 scoring on canned traces: `recovers` passes for a raw id and for a `t<N>` alias resolved through a canned index entry; fails for not-found result, wrong-source block, a call after the final answer, value-without-hit, hit-without-value - `eval/judge.test.ts`
- Judge routing: a reply quoting the old value as rejected is not failed mechanically and reaches the judge with the oracle in its input; failed mechanical check skips the judge; judge JSON parse, one retry, then `error` - `eval/judge.test.ts`
- Row 5: report renders `unavailable` for absent cost and tokens, never `0`, and `(estimated)` for catalog-derived cost - `eval/report.test.ts`
- Row 6: compare prints every case with markers, per-repetition reason changes, overhead deltas, `REGRESSION CANDIDATE` summary, separates errors, exits non-zero on drop or error; comparison-key mismatch including corpus hash aborts; `--change` required; bare invocation prints both examples - `eval/report.test.ts`
- `--baseline` refuses with errored jobs and exits 0 with failing cases; `--runs` other than pinned rejected; dirty tree refused; first-run estimate renders `unavailable (no baseline yet)`; retry recorded in header - `eval/report.test.ts`
- Row 2 live path (real SDK, real models) and row 4 baseline - none: paid and non-deterministic; the committed baseline reports with header metadata and per-repetition observed behavior are the evidence, produced in this branch
- Row 7 / row 8 workflow and invocation rules - none: documentation; `package.json` `test` script unchanged is asserted by `eval/scenarios.test.ts` reading `package.json`
- AGENTS.md eval-gate rule - none: process rule; the `eval:` line in the commit body is the observable

## Documentation impact

Per `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: `eval/README.md` (major procedure + operations/tunable parameters: what the eval measures, comparison key, flags, `EVAL_CONCURRENCY`, retry policy, sampling variance, when to re-baseline, cost, reading a report)
- Materially amended existing docs: `AGENTS.md` (major procedure: "Behavioral eval" section with trigger paths, command, commit-body statement, baseline-first rule); `README.md` (routing row to `eval/README.md`); `CHANGELOG.md` (new `## [Unreleased]` entry for the eval harness and the two baselines, added in this change; `release.sh` promotes it at the next release)
- Derived / memory docs invalidated: `AGENTS.md` Layout block (adds `eval/`) and Testing section (names `bun test eval/` as outside the gate)

## Out of scope

Changing summarization behavior, prompts, clipping, or chain fusion; enriching summarizer input; loop or stop rules; a general eval platform; CI execution of the paid eval; more than two summarizers or more than three runs (both are config constants a later change can raise with a re-baseline); the `AGENTS.md` `transform-messages.js` pointer repair (adjacent, separate commit).

## Open questions

- Cost provenance at the runtime boundary. Probe run: `rg 'streamSimple|completeSimple|modelRuntime|cost\?\.total \?\? 0'` over `src/summarizer.ts`, `src/stats.ts`, `index.ts`, `pi-coding-agent/dist/core/model-runtime.d.ts`, `sdk.d.ts`. Outcome: confirmed that the summarizer calls `ctx.modelRegistry.streamSimple` (`src/summarizer.ts:173`), that `createAgentSession` accepts `modelRuntime` (`sdk.d.ts:16`), and that `ModelRuntime` exposes `streamSimple` and `completeSimple` (`model-runtime.d.ts:100-101`), so the observer can see every summarizer and subject call with the usage pi-ai returns. Inconclusive: whether that `Usage` lets the observer tell provider-reported cost from catalog-estimated cost (members cite `anthropic-messages.js:381-394, 492-502` and `openai-responses-shared.js:505-520` as computing cost from rates). Obtain-hint: read those two provider files and `pi-ai/dist/types.d.ts` `UsageInfo` for a provider-cost field or event. Settles: step 2's `costProvenance` rule, the `(estimated)` rendering in the report, and whether `github-copilot` cost renders `unavailable` or `(estimated)`. Settlement path: the user supplies the fact at the gate, or the plan task that implements `eval/observer.ts` and `eval/observer.test.ts` settles it via brainstorming's amendment path before any paid run.
