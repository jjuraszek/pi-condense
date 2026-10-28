# Behavioral evals and baseline implementation plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Measure downstream context retention with seven synthetic scenarios, real SDK pruning, a frozen judge, and two committed baseline reports.

**Architecture:** Keep the harness under `eval/`, with no production imports or changes. Run every scenario/summarizer/repetition in its own subprocess, load only the real extension, observe the supplied ModelRuntime, and require successful summarization and pruned subject input before scoring. Keep full traces temporary and retain metadata plus per-repetition behavioral evidence in Markdown reports.

**Tech Stack:** Bun, TypeScript, Node filesystem/crypto/child-process APIs, installed `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

**Spec:** `doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md`

**Verification:** `npm test && npm run test:eval && node scripts/check-agents-core.mjs && git diff --check`

**Ticket:** `#22`

---

## Recon and execution constraints

- One plan: the overrides document no deployment split or Happy path table. Keep plans branch-only; the finishing flow removes this plan before landing.
- `package.json` and `.github/workflows/test.yml` define the current test gate; it does not bundle lint or formatting. No ESLint, Prettier, Biome, formatter, or lint script is configured. Use scoped whitespace checks and existing two-space TypeScript style; do not add tooling or alter either CI workflow.
- `src/types.ts:562-594` owns all literal pipeline defaults. `src/config.ts:19-40` lazily reads `contextPrune` from the process-global agent directory. Read defaults, never import them into the harness.
- `src/batch-capture.ts:117-216` matches call/result ids and groups assistant/user turns; lines 221-249 clip each result to 4000 head / 4000 tail. `src/pruner.ts:111-150` emits recovery stubs. `src/indexer.ts:64-158,201-214` reconstructs short refs. `src/query-tool.ts:24-60,89-142` defines recovery arguments and returned source blocks.
- `index.ts:796-851` loads config and rearms on session start; `src/commands.ts:1057-1090` owns the enabled check and manual flush. `src/summarizer.ts:49-76,173-209` uses the supplied runtime and can fall back. `src/summarizer.test.ts:1-170` supplies existing offline regression coverage.
- SDK truth: `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:1-100`, `sdk.js:149-162,256-328`, `resource-loader.d.ts:70-122`, `resource-loader.js:475-478,500-522`, `agent-session.d.ts:166-174`, `agent-session.js:1296-1308,2660-2682`, `model-runtime.d.ts:66-101`, and `session-manager.d.ts:1-27,386`. The prompt is loader-owned through `systemPromptOverride`, not a session option.
- Cost truth: `node_modules/@earendil-works/pi-ai/dist/types.d.ts:285-306` defines `Usage` without provider-cost provenance. `api/anthropic-messages.js:479-503`, `api/openai-responses-shared.js:499-529`, and `api/openai-completions.js:1171-1199` derive cost from rates. `api/simple-options.js:32-38` forwards observation hooks. Only verified priced APIs with finite returned cost can yield `estimated`; otherwise cost is `unavailable`, never provider-reported.
- All offline tests use stub runtimes, no credentials/network, and unique temporary directories. Lifecycle environment changes happen in child processes. No shared mutable runtime resource exists between the two Wave 1 tasks.

## Baseline provenance

Initial BASE: `d16eaf7`. Initial status inventory: `?? doc/plans/2026-10-28-gh-22-behavioral-evals-baseline.md`. Admitted only that plan path; the spec path was clean. Task 4's mixed-anchor command was reduced to `bun test src/summarizer.test.ts` by dropping the created lifecycle-test anchor: exit 0, 8 tests passed, 0 failed. Post-run HEAD remained `d16eaf7` and status was identical, with no artifacts. Both ordinary-repair baseline reruns executed that derived command: each exited 0 with 8 tests passed and 0 failed; pre/post HEAD and inventory remained identical.

Amendment BASE: `6d3c2f9`. Initial inventory: ` M doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md`; admitted that exact spec path, also explicitly supplied as In-flight. The plan path was clean. Endpoint proof `git diff --quiet d16eaf7 HEAD -- . ':!doc/specs/' ':!doc/plans/'` exited 1, so no prior evidence was retained. Regenerated every task baseline: Tasks 1, 2, 3, and 5 anchor only plan-created paths and are skipped under the all-created rule; Task 4 ran the derived `bun test src/summarizer.test.ts`, exit 0, 8 pass, 0 fail, 14 assertions. Post-run HEAD remained `6d3c2f9` and inventory was identical, with no artifacts. Tasks 6-7 declare no Tests commands. Paid baseline generation is an implementation checkpoint, not planning-time evidence. Ordinary citation repair changed no Tests commands; `git diff --quiet 6d3c2f9 6d3c2f9 -- . ':!doc/specs/' ':!doc/plans/'` exited 0; retained 5 bullets: `6d3c2f9` -> `6d3c2f9`, tree-equivalent outside `doc/specs`, `doc/plans`.

Wording-amendment BASE: `0bad341`. Initial inventory: ` M doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md`; admitted that exact spec path, explicitly supplied as In-flight. The plan path was clean. Endpoint proof `git diff --quiet 6d3c2f9 0bad341 -- . ':!doc/specs/' ':!doc/plans/'` exited 1, so no prior evidence was retained. Regenerated every task baseline without changing Tests commands or task ownership: Tasks 1, 2, 3, and 5 still anchor only plan-created paths and skip under the all-created rule, including now-implemented paths. Task 4 ran the derived `bun test src/summarizer.test.ts`: exit 0, 8 pass, 0 fail, 14 assertions. Post-run HEAD remained `0bad341` and inventory was identical, with no artifacts. Tasks 6-7 declare no Tests commands. Both amended spec clauses remain on their original lines, so no anchors move. Ordinary quote repair changed no Tests commands; `git diff --quiet 0bad341 0bad341 -- . ':!doc/specs/' ':!doc/plans/'` exited 0; retained 5 bullets: `0bad341` -> `0bad341`, tree-equivalent outside `doc/specs`, `doc/plans`.

## Files

**Create - configuration and corpus:**
- `eval/config.ts`
- `eval/scenario.ts`
- `eval/scenarios/mid-result-fact.ts`
- `eval/scenarios/unverified-hypothesis.ts`
- `eval/scenarios/disproved-explanation.ts`
- `eval/scenarios/failed-fix-not-disproof.ts`
- `eval/scenarios/repeated-attempts-among-unrelated.ts`
- `eval/scenarios/correction-then-topic-change.ts`
- `eval/scenarios/approval-boundary.ts`
- `eval/scenarios.test.ts`
- `eval/session.test.ts`

**Create - runtime, scoring, and CLI:**
- `eval/observer.ts`
- `eval/observer.test.ts`
- `eval/judge.ts`
- `eval/judge.test.ts`
- `eval/session.ts`
- `eval/lifecycle.test.ts`
- `eval/run.ts`
- `eval/report.ts`
- `eval/report.test.ts`

**Create - evidence and guide:**
- `eval/baseline/claude-haiku-5-5.md`
- `eval/baseline/gpt-6-luna.md`
- `eval/README.md`

**Modify:**
- `package.json` - paid CLI and separate offline eval-test script.
- `AGENTS.md` - Behavioral eval rule, Layout, and Testing outside the shared core.
- `README.md` - eval guide routing.
- `CHANGELOG.md` - Unreleased entry.

**Delete:** none. Production code, lockfiles, shared AGENTS core, CI, and package publishing files remain unchanged.

## Wave 1 - Independent foundations

Task 1 owns the corpus/configuration; Task 2 owns the generic observer and accepts phase/model identities as arguments, without importing Task 1. Tests have no shared environment or files.

### Task 1: Freeze configuration and build the seven seed histories

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Acceptance criteria" L36-L51, § "Layout" L83-L83, § "Pinned configuration (`eval/config.ts`)" L89-L98, § "Pinned configuration (`eval/config.ts`)" L100-L100, § "Scenario shape (`eval/scenario.ts`)" L109-L127, § "Scenario shape (`eval/scenario.ts`)" L130-L130, § "Scenario shape (`eval/scenario.ts`)" L136-L146, § "Errors and edge cases" L203-L203, § "Tests" L210-L214, § "Tests" L223-L223, § "Out of scope" L236-L236

**Files:**
- Create: `eval/config.ts`
- Create: `eval/scenario.ts`
- Create: `eval/scenarios/mid-result-fact.ts`
- Create: `eval/scenarios/unverified-hypothesis.ts`
- Create: `eval/scenarios/disproved-explanation.ts`
- Create: `eval/scenarios/failed-fix-not-disproof.ts`
- Create: `eval/scenarios/repeated-attempts-among-unrelated.ts`
- Create: `eval/scenarios/correction-then-topic-change.ts`
- Create: `eval/scenarios/approval-boundary.ts`
- Create: `eval/scenarios.test.ts`
- Create: `eval/session.test.ts`
- Test: `eval/scenarios.test.ts`
- Test: `eval/session.test.ts`

**Tests:**
- `bun test eval/scenarios.test.ts eval/session.test.ts`
- baseline: 0bad341 skipped - eval/scenarios.test.ts, eval/session.test.ts created by this task
- via: `seedEntries(history)`, `SessionManager.inMemory`, `getBranch()`, `PIPELINE_SETTINGS`

Boundary: create only `eval/` files; no imports from `src/`. The real `index.ts` and `ModelRuntime` integration belongs to later tasks. Task 5 adds `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`); Task 7 owns `AGENTS.md`, `README.md`, and `CHANGELOG.md` `## [Unreleased]`. Leave the `transform-messages.js` pointer and production behavior untouched.

- [ ] **Step 1: Write failing schema and seed tests.** Assert seven file-stem ids, uniqueness, nonempty `tests`/`probe`, `mechanical` or `judged` with concrete `oracle` and `expected`, and complete parent-linked seed messages. Assert `package.json` retains its `test` script value `bun test src/`; this test never invokes the paid CLI. Check fields `role`, `content`, `usage`, `stopReason`, `model`, `provider`, `api`, `timestamp`, tool-call `id`, `name`, `arguments`, and matching `toolResult.toolCallId`.
- [ ] **Step 2: Run red.** Run: `bun test eval/scenarios.test.ts eval/session.test.ts`. Expected: missing harness modules, no network.
- [ ] **Step 3: Freeze model/run constants and the literal pipeline.** Export `SUBJECT_MODEL` as `anthropic/claude-sonnet-5-5`, `SUBJECT_THINKING_LEVEL` as `medium`, `SUMMARIZER_MODELS` as `anthropic/claude-haiku-5-5` and `github-copilot/gpt-6-luna`, `JUDGE_MODEL` as `anthropic/claude-opus-5-5`, `RUNS_PER_CASE` as 3, `DEFAULT_CONCURRENCY` as 8 with `EVAL_CONCURRENCY` override, and `RETRY_POLICY` as two retries at 2000/8000 ms only for HTTP 429 or transport errors. Set `SUBJECT_SYSTEM_PROMPT` to this fixed string in `config.ts`: `You are the coding assistant for the fictional orbital-ledger project. Answer the user's current request using the conversation and available evidence. Distinguish facts from hypotheses, respect corrections and approvals, and recover original tool results when you need their evidence.` Task 3 owns `JUDGE_PROMPT` in `judge.ts` and its `judgePromptHash`. Copy every `DEFAULT_CONFIG` value from `src/types.ts` into this block, with `enabled: true`:

  ```ts
  export const PIPELINE_SETTINGS = {
    enabled: true,
    showPruneStatusLine: true,
    summarizerModel: "",
    summarizerThinking: "default",
    pruneOn: "agent-message",
    batchingMode: "turn",
    quietOversizedSkips: false,
    minBatchChars: 2000,
    recoveryGraceTurns: 3,
    summarizerIdleTimeoutMs: 45000,
    summarizerMaxTimeoutMs: 180000,
    protectedTools: [],
    protectedPaths: ["**/skills/**/*.md", "**/gauntlet-overrides.md"],
    chainCompression: {
      enabled: true,
      rollingWindow: 3,
      stripFinalAssistantThinking: true,
      fuseRangeSummary: true,
    },
    purgeErrors: { enabled: true, cooldownTurns: 2, minArgChars: 500 },
    dedupByContentHash: true,
    autoBudgetThreshold: null,
    spillThreshold: 65536,
    spillPreviewBytes: 2048,
    budgetTurnDelta: null,
    frontierGapThresholdTokens: null,
    maxImagesPerRequest: null,
  } as const;
  ```

  Export stable SHA-256 helpers: sort object keys, blank only `summarizerModel` for `settingsHash`, hash subject prompt bytes, and hash sorted relative scenario paths plus file bytes for corpus identity. The job's literal `contextPrune` settings always substitute the selected summarizer before use. Changing a default in the product must not change this literal; changes to this literal need a re-baseline.

  Decision: keep `github-copilot/gpt-6-luna` - spec L92 records that the requested "luna 6.1" had no id in `pi --list-models` and the user chose this available id during the questionary; `eval/config.ts:6` already pins it. This clarification changes neither the model nor the comparison key.
- [ ] **Step 4: Implement the public seed shape.** Define `Scenario` exactly as spec lines 109-127 and a discriminated `SeedTurn` union of user, assistant, and result messages. `seedEntries(history)` returns `FileEntry[]` with one session header, deterministic timestamps, distinct entry ids, and a `parentId` chain from first message to leaf. Use complete `AssistantMessage` objects per `pi-ai/dist/types.d.ts`, `toolCall` blocks, and `toolResult` messages joined by `toolCallId`; every scenario call has one result, so `insertSyntheticToolResults` is never needed. Fixed call ids follow the scenario and ordinal convention. Invented seed usage may be zero; measured usage may not be fabricated.

  Decision: the first message has null parent, later messages point to preceding message ids, and the header is not a message parent - `session-manager.d.ts:5-27` and `getBranch()` settle traversal. Use the exported current session version and seed subject API `anthropic-messages`.
- [ ] **Step 5: Build middle-fact and repeated-attempt fixtures.** `mid-result-fact` uses a 12000-character fictional `orbital-ledger` file with `retry_window_ms=7319` near offset 6000, absent elsewhere in history/probe. Require `recovers` for `call_mid-result-fact_1` with that evidence and `contains` for `7319`. Repeated attempts use distinct `A-SCAN`, `A-REINDEX`, and `A-REPLAY` result bodies interleaved with unrelated B work; require all three A ids and identifiers. Use distinct filler to avoid content deduplication. Avoid unnecessary text-only chain closings that would range-prune away all seeded stubs.
- [ ] **Step 6: Build the three hypothesis fixtures.** Unverified: assistant proposes a stale checkpoint but never checks it; an unrelated eligible result supplies the tool batch. Disproved: assistant proposes a missing shard, then a result shows it present while the error persists. Failed fix: assistant proposes an outdated replay index, but rebuilding fails because a synthetic scratch directory is read-only, which does not test the hypothesis. Each file carries its own `tests` paragraph, oracle, expected sentence, and probe.
- [ ] **Step 7: Build correction and approval fixtures.** Correction changes fictional queue limit 24 to 42, shifts topic, then probes the limit; require `contains: ["42"]`, while the judge accepts quotation of 24 as rejected. Approval authorizes inspect-only step 1 but not replacement step 2; probe asks to proceed and the oracle expects offering step 1 plus asking before step 2. Offering is appropriate with no write tool exposed. Every capturable result is distinct and at least 3000 characters.
- [ ] **Step 8: Add hygiene, size, and evidence-shape tests.** Reject `/Users/`, `@`, credential-prefix shapes `sk-`/`ghp_`, and real hostnames in fixture content. Check paths against `PIPELINE_SETTINGS.protectedPaths`, including `**/skills/**/*.md` and `**/gauntlet-overrides.md`. Compute capturable sizes from history, per assistant turn and user group without importing capture code, and require at least 1.5 times `PIPELINE_SETTINGS.minBatchChars`. The assertions read `protectedPaths` and `minBatchChars` from the pinned block. Assert middle fact outside both 4000-char windows and no leak in other seeds/probe. Keep fixtures below summarizer context capacities. Recovery's later contract uses `context_tree_query`, `context-prune-index`, a matching `## toolRef` block containing `evidence`, then reply `contains`; never treat a correct-looking value alone as a pass.
- [ ] **Step 9: Run green.** Run: `bun test eval/scenarios.test.ts eval/session.test.ts`. Expected: schema, complete branch traversal, hygiene, and eligibility tests pass offline.
- [ ] **Step 10: Format & lint.** No formatter/linter is configured; match adjacent TypeScript. Run: `git diff --check -- eval/config.ts eval/scenario.ts eval/scenarios eval/scenarios.test.ts eval/session.test.ts`. Expected: no whitespace errors.
- [ ] **Step 11: Commit.** Run: `git add eval/config.ts eval/scenario.ts eval/scenarios eval/scenarios.test.ts eval/session.test.ts && git commit -m "Add frozen synthetic eval corpus" -m "Refs #22"`.

### Task 2: Observe runtime calls without changing results or inventing measurements

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Problem" L26-L26, § "Acceptance criteria" L36-L51, § "Layout" L83-L83, § "One job (`eval/session.ts`)" L153-L153, § "Errors and edge cases" L196-L196, § "Errors and edge cases" L199-L199, § "Errors and edge cases" L204-L204, § "Tests" L216-L216

**Files:**
- Create: `eval/observer.ts`
- Create: `eval/observer.test.ts`
- Test: `eval/observer.test.ts`

**Tests:**
- `bun test eval/observer.test.ts`
- baseline: 0bad341 skipped - eval/observer.test.ts created by this task
- via: `observe`, `ModelRuntime.streamSimple`, `ModelRuntime.completeSimple`

Boundary: keep `eval/` independent of `src/`; reach the product through `index.ts` and `ModelRuntime`. Other tasks add `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`), and `AGENTS.md`, `README.md`, `CHANGELOG.md` `## [Unreleased]` documentation.

- [ ] **Step 1: Write transparent-observer tests.** Use a structural stub runtime and real AssistantMessageEventStream. Cover iteration and `result()` together, completions, synchronous throws, promise rejections, terminal error/aborted messages, missing usage/cost, explicit measured zero, response-model overrides, and subject-model fallback during summarization. Assert one record per public invocation, unmodified return/error identities, and no credential/options/raw-error-string leakage. Cover finite cost on each verified API, non-finite cost, an unpriced model, and an unknown API; no cost record may have `provider` provenance.
- [ ] **Step 2: Run red.** Run: `bun test eval/observer.test.ts`. Expected: missing observer implementation.
- [ ] **Step 3: Implement `observe`.** Return a runtime-compatible wrapper, records, and phase setter for summarizer/subject/judge. Bind unwrapped methods to the original runtime for private-field safety. `streamSimple` returns the original stream and attaches a terminal `result()` observer without consuming its iterator. `completeSimple` awaits the original bound method and records once. Snapshot `context` at start; store `model.provider/model.id`, requested and answered identities including responseModel, `ok` or sanitized error class, raw `AssistantMessage.usage`, elapsed monotonic time, and cost provenance. Do not serialize options, credentials, response headers, or full provider errors. Read no operator credentials here; `getAgentDir()` is resolved by the parent entry and the job runtime is supplied by Task 4.
- [ ] **Step 4: Separate availability from raw measurements.** Preserve raw usage without `?? 0`. Chain caller `onProviderStreamEvent` behavior while extracting only usage-field presence and safe status categories. Anthropic usage arrives in message_start/message_delta; Responses usage is in terminal response.usage. For `openai-completions`, inspect chunk.usage or the first choice's usage as the adapter does, and map prompt/completion/cache fields without inventing absent counts (`api/openai-completions.js:353-372,1171-1199`). No full provider payload is logged. Missing fields normalized to zero by pi-ai get unavailable availability; an explicitly reported zero remains measured zero. Unknown APIs or absent provider evidence fail closed to unavailable. Aggregation sums only known fields and propagates missingness.

  Decision: installed `Usage` has no provider-reported cost field. Restrict catalog-derived cost to the verified `anthropic-messages`, `openai-responses`, and `openai-completions` APIs: a priced model with finite returned cost is `estimated`, including priced GitHub Copilot calls on those APIs; an unpriced model, unknown API, absent cost, or non-finite cost is `unavailable`. Never label cost `provider`. Sources: spec L26/L153, `pi-ai/dist/types.d.ts:285-306`, and the catalog calculation calls at `dist/api/anthropic-messages.js:502`, `openai-responses-shared.js:520`, and `openai-completions.js:1198`. Test absent token fields despite normalized zeros, absent cost, finite zero cost on a priced model, priced Copilot, unpriced models, unknown APIs, NaN, and both infinities. Keep token availability separate from cost provenance and render `(estimated)` for estimated cost.
- [ ] **Step 5: Classify phase errors.** Export a classifier taking records and expected summarizer identity. A different requested or answered model during summarization is `error: summarizer-fallback`; a terminal summarizer call failure is `error: summarizer`. Keep retryable transport/HTTP metadata separate and sanitized. These are not `fail`: `--baseline` refuses them and `--compare` separates them from regressions. Classify fallback before summarizer error before missing-flush evidence.
- [ ] **Step 6: Run green against the settled cost contract.** Run: `bun test eval/observer.test.ts`. Expected: transparency, safe records, missingness, verified finite catalog cost, and fallback tests pass offline. The approved amendment settles cost provenance; no further amendment or design question precedes execution. Task 4 consumes these records and configures the loader-owned prompt. Every eval write outside `eval/baseline/` stays under the run's `mktemp -d`; credentials are never copied into job dirs, logged, or written into any eval artifact. The runtime's own OAuth refresh of the operator's `auth.json` through standard `DefaultAuthStorage` behavior remains unchanged and is not an eval write (spec L204).
- [ ] **Step 7: Format & lint.** No formatter/linter is configured. Run: `git diff --check -- eval/observer.ts eval/observer.test.ts`. Expected: no whitespace errors.
- [ ] **Step 8: Commit.** Run: `git add eval/observer.ts eval/observer.test.ts && git commit -m "Observe eval calls and measurement provenance" -m "Refs #22"`.

## Wave 2 - Evidence-aware scoring

Depends on Wave 1: Task 3 consumes the scenario shape, model pins, and observed runtime. No paid calls run here.

### Task 3: Gate recovery mechanically and judge semantic behavior against frozen oracles

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Acceptance criteria" L36-L51, § "Layout" L83-L83, § "Pinned configuration (`eval/config.ts`)" L104-L104, § "Scenario shape (`eval/scenario.ts`)" L136-L146, § "Scoring (`eval/judge.ts`)" L164-L164, § "Errors and edge cases" L197-L197, § "Tests" L217-L218

**Files:**
- Create: `eval/judge.ts`
- Create: `eval/judge.test.ts`
- Test: `eval/judge.test.ts`

**Tests:**
- `bun test eval/judge.test.ts`
- baseline: 0bad341 skipped - eval/judge.test.ts created by this task
- via: `context_tree_query`, `completeSimple`, `JUDGE_PROMPT`

Boundary: `eval/` imports nothing from `src/`; `index.ts` is loaded by the session with `ModelRuntime`. Other tasks own `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`), plus `AGENTS.md`, `README.md`, and `CHANGELOG.md` `## [Unreleased]`.

- [ ] **Step 1: Write recovery red tests.** Canned ordered traces cover raw-id and alias hits, returned alias labels, not-found, wrong source, right id without evidence, result after final answer, no call, value-without-hit, hit-without-value, and one missing of three required recoveries. For multi-id calls require evidence in the matching `## toolRef` block, never its neighbor. Test an earlier miss followed by a valid hit.
- [ ] **Step 2: Write judge-routing tests and run red.** Canned replies cover `use 42; my earlier 24 was wrong`, unsupported claims, invalid JSON, wrong field types, empty reasons, and malformed then valid JSON. Mechanical failure skips the judge. Input includes the oracle, never raw history. Run: `bun test eval/judge.test.ts`. Expected: missing scorer.
- [ ] **Step 3: Implement ordered recovery gates.** Export ToolObservation with `name`, `arguments`, `result`, call `index`, `resultIndex`, and `toolCallId`, plus recovery outcomes. Export a scorer consuming scenario/reply/toolCalls/finalAssistantIndex/short-ref map/runtime. Resolve aliases through `context-prune-index` and summary toolCallRefs. A `context_tree_query` call must name the required id, its returned block must match and contain `evidence`, and result completion must precede the final answer. Right source without evidence is wrong-source, explicit not-found is not-found, no eligible call is no-call. Require every `recovers` result and reply `contains`. Name failed gates with the literal/id/outcome, keep semantics such as quotation and negation out of mechanical scoring.

  Decision: add result completion order instead of comparing only call start `index` - spec L146 and `src/query-tool.ts:47-60,109-113` require the source result before the final text.
- [ ] **Step 4: Implement the frozen oracle judge.** Define `JUDGE_PROMPT` as a fixed system prompt plus rubric: score only supplied oracle, expected, probe, reply, and tool trace; distinguish assertion, quotation, negation, correction, and approval; fail unsupported claims; return only JSON `{ pass: boolean, reason: string }` with nonempty reason. Hash its exact bytes. For a `judged` case passing mechanical gates, call `runtime.getModel("anthropic", "claude-opus-5-5")` then observed `completeSimple`, no temperature, input exactly `{ oracle, expected, probe, reply, toolCalls }`. A mechanical-only case needs no call. Unparseable or invalid `{ pass, reason }` JSON retries once then yields `error: judge`; other judge provider failures preserve their safe error category. Freeze `claude-opus-5-5` identity rather than promising deterministic sampling; `RUNS_PER_CASE` handles variance.
- [ ] **Step 5: Run green.** Run: `bun test eval/judge.test.ts`. Expected: all source-order, literal, oracle-routing, and two-attempt parse-limit tests pass. Preserve full judge input/output only in temporary job artifacts, and return pass/fail/error plus check/reason for reporting.
- [ ] **Step 6: Format & lint.** No formatter/linter is configured. Run: `git diff --check -- eval/judge.ts eval/judge.test.ts`. Expected: no whitespace errors.
- [ ] **Step 7: Commit.** Run: `git add eval/judge.ts eval/judge.test.ts && git commit -m "Score recovery evidence and judged behavior" -m "Refs #22"`.

## Wave 3 - Real SDK lifecycle with offline evidence

Depends on Waves 1-2: Task 4 loads seeds through the actual extension and consumes observer/scoring contracts. Each lifecycle case owns a subprocess environment.

### Task 4: Drive an isolated session through flush, pruning, recovery, and scoring

**TDD scenario:** New feature - full TDD cycle, with existing summarizer tests first.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Problem" L26-L26, § "Acceptance criteria" L36-L51, § "Layout" L83-L83, § "One job (`eval/session.ts`)" L150-L152, § "One job (`eval/session.ts`)" L153-L153, § "One job (`eval/session.ts`)" L154-L155, § "One job (`eval/session.ts`)" L156-L156, § "One job (`eval/session.ts`)" L157-L157, § "One job (`eval/session.ts`)" L158-L160, § "Errors and edge cases" L194-L196, § "Errors and edge cases" L204-L204, § "Tests" L215-L215

**Files:**
- Create: `eval/session.ts`
- Create: `eval/lifecycle.test.ts`
- Test: `eval/lifecycle.test.ts`
- Test: `src/summarizer.test.ts`

**Tests:**
- `bun test eval/lifecycle.test.ts src/summarizer.test.ts`
- baseline: 0bad341 pass via `bun test src/summarizer.test.ts`
- via: `createAgentSession`, `SessionManager.inMemory`, `session.bindExtensions`, `session.prompt("/pruner now")`, `index.ts`

Boundary: `eval/` imports nothing from `src/`, reaching `index.ts` through the real SDK and `ModelRuntime`. Other tasks add `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`), and `AGENTS.md`, `README.md`, `CHANGELOG.md` `## [Unreleased]` documentation.

- [ ] **Step 1: Run existing tests and write lifecycle red cases.** Run: `bun test src/summarizer.test.ts`. Expected: existing request-shape tests pass. Add stub-runtime lifecycle cases for all seven seeds, disabled settings, `skipped-trivial`-sized batches, missing index coverage, extension error, unexpected tools/context, summarizer error/fallback, and raw subject input. Stub model metadata, registry methods, complete terminal messages, and provider usage events. Use real loader/extension behavior, not a copied prune function; assert no provider access. Assert the loader returns the pinned prompt through its override and the effective prompt includes only that preamble and the normalized job cwd section.
- [ ] **Step 2: Run red.** Run: `bun test eval/lifecycle.test.ts src/summarizer.test.ts`. Expected: missing job implementation while existing tests remain green.
- [ ] **Step 3: Implement one-job setup.** Export runJob for injected offline runtimes and guard the real main entry. `run.ts` launches `bun eval/session.ts` with scenario, summarizer, run index, job path, operator agentDir, and repo path. Before startup its child env points PI_CODING_AGENT_DIR to the job agent directory. Under one `mktemp -d`-equivalent root create `agent/settings.json` with full `PIPELINE_SETTINGS` for the model and empty `cwd/`. Resolve operator `getAgentDir()` in the parent before overrides; use explicit authPath/modelsPath for runtime creation, and a job-local modelsStorePath for cache writes. Do not copy credential files into job dirs, log credentials, or write them into any eval artifact. Import `observe` from `eval/observer.ts` and pass its wrapped `streamSimple` and `completeSimple` boundary through the runtime. It stores `model.provider/model.id`, `context`, `ok`/safe errors, raw `AssistantMessage.usage` without `?? 0`, and cost provenance `estimated` only for finite returned cost on a priced model using `anthropic-messages`, `openai-responses`, or `openai-completions`; otherwise `unavailable`, never `provider`. Preserve that distinction in job output: `Usage` at `dist/types.d.ts:285-306` has no provider-cost field, and `dist/api/anthropic-messages.js:502`, `openai-responses-shared.js:520`, and `openai-completions.js:1198` calculate from catalog rates.

  Decision: leave the runtime's own OAuth refresh of the operator's `auth.json` unchanged; it is not an eval write - spec L204 explicitly excludes this standard `DefaultAuthStorage` behavior required for Copilot tokens. `eval/session.ts:56` already supplies the operator auth path; the installed `auth-storage.js:122-148,385-400` persists credential updates under a lock. Keep the job-local cache and credential-free artifacts; do not redirect refreshed credentials into job dirs.
- [ ] **Step 4: Load and bind exactly one extension.** Use DefaultResourceLoader with cwd/agentDir, only repo index.ts in additionalExtensionPaths, `noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`, `noThemes: true`, `noContextFiles: true`, and `systemPromptOverride: () => SUBJECT_SYSTEM_PROMPT`; `await reload()`. Assert precisely the resolved extension path and no loader errors. Resolve subject Model object, pass modelRuntime/resourceLoader, seeded in-memory SessionManager, `noTools: "builtin"`, and explicit thinking level to createAgentSession. The spec's `await session.bindExtensions(...)` means bind with an `onError` listener collecting sanitized extension failures; `session_start` errors are `error: extension`. Require active tools exactly `[context_tree_query]`.

  Decision: use the approved SDK call `createAgentSession({ cwd, agentDir, model: runtime.getModel("anthropic", "claude-sonnet-5-5"), modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(cwd, undefined, seedEntries(history)), noTools: "builtin", thinkingLevel: SUBJECT_THINKING_LEVEL })`. Do not pass a systemPrompt session option: `sdk.d.ts:10-64` has none, `resource-loader.d.ts:70-122` owns `systemPromptOverride`, `resource-loader.js:475-478` applies it, and `agent-session.js:1296-1308` reads the loader. `system-prompt.js:69-137` yields the custom preamble plus only the normalized job cwd section when context/skills/addendum are absent. Assert those exact sections, allowing only the job path as runtime-owned variation; any extra material is `error: isolation`. The approved amendment already records this contract; no further amendment gate is needed.
- [ ] **Step 5: Prove enabled summarization.** Set observer phase before binding, capturing rearm calls. Execute `await session.prompt("/pruner now")`. Require a `context-prune-flush-metrics` entry with `outcome: "summarized"` and `processedBatches >= 1`, every seeded id in `context-prune-index` or summary `toolCallRefs`, and at least one pinned successful summarizer call. The stub-runtime fixture asserts `outcome: summarized` behavior. Apply fallback/error classification first; otherwise missing proof is `error: no flush`. Disabled/trivial settings never pass. Product call errors are `error: summarizer`, wrong-model calls are `error: summarizer-fallback`, not behavioral `fail`; `--baseline` refuses and `--compare` separates them.
- [ ] **Step 6: Probe and inspect actual outgoing context.** Execute `await session.prompt(probe)` in subject phase. Inspect the first subject call, not raw branch state: seeded result bodies absent, actual summary and seeded-result stubs present. Check the production stub format read from `src/pruner.ts:111-150` with actual short refs. Otherwise emit `error: not pruned`. Collect only post-probe final assistant text, ordered calls/results with completion indices, and short-ref maps from real entries. Aggregate subject/summarizer usage with `unavailable` propagation and wall times for flush/probe/total.
- [ ] **Step 7: Score, dispose, and serialize.** Before disposal set judge phase and score with the same runtime. Preserve spec output `{ reply, toolCalls: [{ name, arguments, result, index }], recovery: [{ id, outcome: "hit" | "not-found" | "wrong-source" | "no-call" }], usage: { subject, summarizer }, costProvenance, elapsedMs: { flush, probe, total }, attempts, status: "ok" | "error", errorReason? }`. Add internal result/final event indices, verdict/check/reason, phase-separated judge overhead, summaries, prompts, and observer records. `dispose()` in finally; write `job.json` even for safe diagnostic errors. Keep runtime status distinct from pass/fail. No full prompt or credentials enter retained reports; every eval write outside `eval/baseline/` stays temporary, and the parent prints its root. The runtime's OAuth refresh of the operator's `auth.json` is not an eval write.
- [ ] **Step 8: Run green and review real-path evidence.** Run: `bun test eval/lifecycle.test.ts src/summarizer.test.ts`. Expected: all seven histories traverse real enabled capture/flush/prune with a stub model, active tools are isolated, malformed controls return errors, and no network occurs. Fix SDK integration only in the harness, never by bypassing index.ts or weakening proof checks.
- [ ] **Step 9: Format & lint.** No formatter/linter is configured. Run: `git diff --check -- eval/session.ts eval/lifecycle.test.ts`. Expected: no whitespace errors.
- [ ] **Step 10: Commit.** Run: `git add eval/session.ts eval/lifecycle.test.ts && git commit -m "Exercise real pruning through isolated SDK sessions" -m "Refs #22"`.

## Wave 4 - Reproducible orchestration and reports

Depends on Waves 1-3: Task 5 uses the complete job entry, observer, and scorer. Script changes and CLI/report tests share this task.

### Task 5: Add the paid CLI, bounded subprocess pool, and baseline comparison reports

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Acceptance criteria" L36-L51, § "Acceptance criteria" L53-L53, § "Layout" L83-L83, § "Pinned configuration (`eval/config.ts`)" L102-L102, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L168-L168, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L170-L170, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L172-L172, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L174-L174, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L176-L176, § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L178-L178, § "Errors and edge cases" L192-L193, § "Errors and edge cases" L196-L196, § "Errors and edge cases" L198-L202, § "Errors and edge cases" L204-L204, § "Tests" L208-L208, § "Tests" L219-L221, § "Out of scope" L236-L236

**Files:**
- Create: `eval/run.ts`
- Create: `eval/report.ts`
- Create: `eval/report.test.ts`
- Modify: `package.json`
- Test: `eval/report.test.ts`

**Tests:**
- `bun test eval/report.test.ts`
- baseline: 0bad341 skipped - eval/report.test.ts created by this task
- via: `eval/run.ts`, `eval/report.ts`, `--compare`, `--baseline`

Boundary: no imports from `src/` or changes to `index.ts`; use `ModelRuntime` through the SDK. Add only `eval/` and `package.json` scripts; Task 7 owns `AGENTS.md`, `README.md`, `CHANGELOG.md` `## [Unreleased]` and leaves `transform-messages.js` untouched.

- [ ] **Step 1: Write CLI/preflight red tests.** Inject status/model/auth/spawn/clock/filesystem seams, forbidding live providers. Cover bare `npm run eval` printing both runnable examples and failing, default/explicit compare, nonblank required change text, unknown flags, incompatible modes, invalid summarizer, positive integer runs/concurrency, EVAL_CONCURRENCY, baseline runs other than 3, dirty tracked/untracked paths, absent models, and unauthenticated Copilot. Failures must spawn no jobs or write artifacts.
- [ ] **Step 2: Write report/pool red tests and run red.** Cover seven cases x three repeats, pass/fail/error, fail reasons, source outcomes, 600-char excerpts, ordered tools, missing versus measured-zero usage, catalog cost, retry and judge overhead, no prior baseline, every key mismatch, package-version warnings, and pool limits. Run: `bun test eval/report.test.ts`. Expected: missing run/report exports.
- [ ] **Step 3: Implement flags, clean-tree preflight, and baseline decoding.** Export argument parsing/main behind an import-safe guard. Default to `--compare`, require `--change`, support `--baseline`, `--summarizer`, and `--runs` and reject unsupported combinations; baseline requires pinned runs. Refuse nonempty `git status --porcelain`, showing status, before runtime/artifact setup. Capture full clean git SHA. Resolve every pinned id with observed runtime lookup and auth availability; absent/unauthenticated ids name `pi --list-models` and abort without jobs. Use memory-only model storage for preflight so failed preflight writes nothing. Read selected committed reports and compare keys before scheduling.

  Define a versioned machine-readable metadata block inside the Markdown report, not a committed sidecar. Store the exact key `{ SUBJECT_MODEL, SUBJECT_SYSTEM_PROMPT hash, SUBJECT_THINKING_LEVEL, summarizer, JUDGE_MODEL, judgePromptHash, settingsHash, corpusHash, RUNS_PER_CASE }`, full literal pipeline/model settings, SDK versions, revision/date, and per-repetition report data. The effective run override fills the run-count key. Mismatch aborts with both headers; `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` version differences only warn. Missing baseline directs baseline mode, never silently replaces it.
- [ ] **Step 4: Implement confined subprocess orchestration.** After preflight create one `mktemp -d`-equivalent root using mkdtemp under OS temp storage. Jobs are scenarios x `RUNS_PER_CASE` x selected summarizers. A bounded pool of `DEFAULT_CONCURRENCY` (8, overridden by `EVAL_CONCURRENCY`) spawns `bun eval/session.ts` with per-job absolute args and immutable child env, never parent env mutation. Keep every job/attempt/cache/cwd/settings file below the root; only generated reports may be written under `eval/baseline/`. Capture sanitized results/errors without auth/options logging. Credentials are never copied into job dirs, logged, or written into any eval artifact; leave the runtime's own OAuth refresh of the operator's `auth.json` through standard `DefaultAuthStorage` behavior unchanged, outside the eval-write rule (spec L204). Retain all temp evidence and print its root when finished. Schedule both summarizers in one invocation and delay baseline writes until all selected jobs finish.
- [ ] **Step 5: Implement retry accounting.** `RETRY_POLICY` restarts a job only after terminal provider HTTP 429 or transport failure: fresh directory, delays 2s then 8s, two retries. Record attempt count, added elapsed/backoff time, wasted-call usage, and judge overhead. After exhaustion use `error: provider`. Judge parse errors, summarizer failures, fallback, extension/isolation, and no-flush/not-pruned are not retried. Test exact delays, independent env/dirs, limit adherence, and each nonretryable class with a fake clock.

  Decision: `error: summarizer` and `error: summarizer-fallback` stay nonretryable even when the underlying failure resembles a transport error - spec L170/L196 explicitly excludes them. Neither is `fail`; `--baseline` refuses errors and `--compare` lists them apart. Do not infer provider classification from arbitrary message substrings.
- [ ] **Step 6: Render the header and per-case evidence.** Print purpose in two sentences and each key value before jobs; include installed `@earendil-works/pi-coding-agent` and `pi-ai` versions, SHA, date, scoring method, hash, retry policy/count, and baseline-derived estimated cost/duration or `unavailable (no baseline yet)`. Final retained header includes actual retries. For each scenario render `tests`, oracle/`expected` or a mechanical sentence, `passes n/3, errors m` with actual denominator for overrides, then each repeat's verdict, failed check or judge reason, recovery, first 600 reply characters, `name(arguments) -> outcome`, phase tokens in/out, elapsed, cost, and totals. Never turn a missing value into `0`; render `unavailable` and `(estimated)` as applicable. Separate judge/retry overhead and preserve missingness in totals/deltas. Escape Markdown metacharacters without changing the machine metadata.

  Record corpus revision as clean code SHA plus content hash of `eval/scenarios/`; source outcomes concern actual `context_tree_query` `## toolRef` results. The report names the intended change and links process guidance in `AGENTS.md`; the later workflow's observable is the `eval:` commit-body line. Full replies, summaries, judge prompts, and observer logs remain temporary.
- [ ] **Step 7: Implement baseline/compare write and exit policy.** Prepare selected reports in memory; any errored job means no baseline file is written. Behavioral failures alone still write baseline reports and return 0. Single-summarizer mode writes only its known basename. Compare writes candidate reports under temp, prints paths/change text, every case as `baseline n/3 -> candidate n/3` with `=`, `+`, or `-`, each repetition's changed check/reason/recovery, overhead deltas, and errors apart. Print a `REGRESSION CANDIDATE` summary line with case and before/after counts for each drop. Any drop or error exits nonzero. No unknown cost/token field becomes a zero delta. Require exact comparison key including corpus/run count; never compare incompatible reports.
- [ ] **Step 8: Wire scripts without changing the gate.** Add `eval` as `bun eval/run.ts` and `test:eval` as `bun test eval/` in package.json; assert those values in report tests. Keep `bun test src/` as the existing test script invoked by `npm test`. Document `npm run test:eval` as the separate offline eval-test invocation outside the release gate. Help prints `npm run eval -- --change "<what changed>"` and `npm run eval -- --baseline`. Do not add production changes, dependency/lockfile changes, new summarizer pins, paid CI, or a general eval platform.
- [ ] **Step 9: Run green.** Run: `bun test eval/report.test.ts`. Expected: preflight, CLI, pool, retry, metadata roundtrip, unknown/estimated usage, comparison, write policy, and exit-code tests pass offline.
- [ ] **Step 10: Format & lint.** No formatter/linter is configured. Run: `git diff --check -- eval/run.ts eval/report.ts eval/report.test.ts package.json`. Expected: no whitespace errors.
- [ ] **Step 11: Commit.** Run: `git add eval/run.ts eval/report.ts eval/report.test.ts package.json && git commit -m "Add paid eval orchestration and baseline comparison" -m "Refs #22"`.

## Wave 5 - Produce baseline evidence on unchanged production code

Depends on Waves 1-4 and their commits. Offline observer/lifecycle evidence must pass before this paid checkpoint; the approved spec already settles cost provenance and loader-owned prompt configuration. Both baseline files and external providers belong to this serialized task.

### Task 6: Run and commit both real-model baseline reports

**TDD scenario:** Trivial change - generated evidence, not code.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Problem" L26-L26, § "Acceptance criteria" L36-L51, § "Baseline production in this branch" L188-L188, § "Errors and edge cases" L204-L204, § "Tests" L222-L222

**Files:**
- Create: `eval/baseline/claude-haiku-5-5.md`
- Create: `eval/baseline/gpt-6-luna.md`

**Tests:**
- none: generated paid evidence; offline harness assertions belong to Tasks 1-5

- [ ] **Step 1: Confirm the clean checkpoint.** Check harness/corpus commits and offline observer/lifecycle acceptance against the approved finite-cost and `systemPromptOverride` contracts. Confirm `src/` and `index.ts` are unchanged from initial product revision `d16eaf7`. Run: `git status --porcelain --untracked-files=all`. Expected: empty; do not stash/discard to pass. Commit authorized workflow documents before starting.
- [ ] **Step 2: Generate both paid baselines.** Run: `npm run eval -- --baseline`. Expected: 42 jobs before retries, 21 per summarizer, three per case, both reports at the same committed SHA. This produces one baseline per summarizer in one invocation, avoiding a second preflight against the first report's uncommitted file. Case failures may yield success; job errors may not. Every eval write outside `eval/baseline/` stays under one `mktemp -d`; credentials are never copied into job dirs, logged, or written into any eval artifact. The runtime's own OAuth refresh of the operator's `auth.json` through standard `DefaultAuthStorage` behavior remains unchanged and is not an eval write (spec L204).
- [ ] **Step 3: Inspect before staging.** Read both reports for seven cases, expected/observed behavior per repeat, reasons and recovery outcomes, model/settings/hash/revision metadata, retry counts, usage/time/cost availability, and totals. Confirm cost is `estimated` only for verified priced APIs with finite cost, otherwise `unavailable`, never provider-reported: `Usage` at `dist/types.d.ts:285-306` has no provider-cost field; `dist/api/anthropic-messages.js:502`, `openai-responses-shared.js:520`, and `openai-completions.js:1198` calculate catalog cost. Check no private paths, identities, credentials, or full contexts were committed. Preserve behavioral failures unchanged. If jobs error after retries, keep temp evidence, fix only the harness, commit the fix, and rerun. Missing auth/models blocks production, not permission to substitute models or fabricate evidence; inability to drive index.ts must be fixed in the harness.
- [ ] **Step 4: Commit reports next.** Run: `git add eval/baseline/claude-haiku-5-5.md eval/baseline/gpt-6-luna.md && git commit -m "Record context-retention baselines for both summarizers" -m "Refs #22"`. Expected: only the two generated reports, with no errored jobs, committed immediately after the clean harness checkpoint.

## Wave 6 - Cross-cutting documentation and workflow rule

Depends on Wave 5: quote measured cost/duration and link actual committed baselines. Merge all hub-doc edits into this trailing doc-only task.

### Task 7: Document invocation, report reading, variance, and the eval gate

**TDD scenario:** Trivial change - documentation review.

**Spec:** doc/specs/2026-10-28-gh-22-behavioral-evals-baseline.md § "Acceptance criteria" L36-L51, § "Layout" L83-L83, § "Pinned configuration (`eval/config.ts`)" L100-L100, § "Pinned configuration (`eval/config.ts`)" L104-L104, § "Documentation and workflow rule" L182-L182, § "Documentation and workflow rule" L184-L184, § "Tests" L208-L208, § "Tests" L224-L224, § "Documentation impact" L230-L232, § "Out of scope" L236-L236

**Files:**
- Create: `eval/README.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Tests:**
- none: documentation; check commands and baseline numbers against their owners

- [ ] **Step 1: Document purpose, corpus, and baseline provenance.** In `eval/README.md`, explain measuring subject behavior after actual summarization/pruning, not summary formatting. Copy all seven `tests` paragraphs into a table, distinguish evidence gates from the oracle judge, link both baseline reports and recorded SHA, and state both were produced in this branch on unchanged production code. Explain `eval/` reaches `index.ts` through `ModelRuntime` and imports nothing from `src/`.
- [ ] **Step 2: Document invocation and operations.** Include `npm run eval -- --change "<what changed>"` and `npm run eval -- --baseline`, clean-tree/model/auth preflight and pi --list-models, default compare/change requirement, single-model selection, run-count restrictions, `EVAL_CONCURRENCY`, two retries/delays, temporary artifacts, and failures. Describe `package.json` scripts `eval` (`bun eval/run.ts`) and `test:eval` (`bun test eval/`), plus unchanged `bun test src/` invoked by `npm test`. Document `npm run test:eval` as the separate offline eval-test invocation outside the existing unit/release gate.
- [ ] **Step 3: Explain reports, frozen identity, and variance.** Show one actual case's expected/observed behavior, recovery and reason, measured overhead, unavailable fields and estimated cost. State every comparison-key field and SDK-version-warning rule. Quote measured baseline cost/duration, never invented numbers. A `DEFAULT_CONFIG` change does not alter the literal; edit settings and re-baseline deliberately. Re-baseline for any key change including scenario/judge prompt. `claude-opus-5-5` identity is frozen, not deterministic; no temperature is sent and `RUNS_PER_CASE` provides repetitions. One pass drop is a candidate: rerun the same compare once, preserve both temp dirs, treat two consecutive drops as regression.
- [ ] **Step 4: Add AGENTS workflow rules outside shared core.** Add Behavioral eval with triggers `src/summarizer*.ts`, `src/batch-capture.ts`, `src/chain-*.ts`, `src/pruner.ts`, `index.ts` prune hooks, and stub text. Require comparison before landing and its result line in the change commit body; non-trigger changes record `eval: not needed - <paths touched>`. A PR may repeat, not replace, the `eval:` record. Name select-classify-summarize and recent-dialogue enrichment as baseline-first changes. Add eval to Layout and offline eval tests to Testing. Leave the adjacent `transform-messages.js` pointer untouched.
- [ ] **Step 5: Route and record the feature.** Add `README.md` routing to `eval/README.md`, synchronized with AGENTS. Add `CHANGELOG.md` `## [Unreleased]` bullet for harness plus two baselines ending in `(#22)`; `release.sh` promotes it later. Do not claim paid CI or all cases passing. Keep out-of-scope prompt/clipping/fusion/enrichment/loop changes out of this commit.
- [ ] **Step 6: Review and commit.** Read touched units against config/scripts/reports, check links, use compact Markdown tables and ASCII punctuation. Run: `git diff --check -- eval/README.md AGENTS.md README.md CHANGELOG.md`. Expected: no whitespace errors. Run: `git add eval/README.md AGENTS.md README.md CHANGELOG.md && git commit -m "Document behavioral eval workflow and retained baselines" -m "Refs #22"`.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Problem" L26-L26 | Verified priced APIs with finite cost yield estimated, otherwise unavailable, never provider-reported; offline real lifecycle before paid runs | Task 2, Task 4, Task 6 |
| § "Acceptance criteria" L36-L51 | Seven checked-in synthetic behavior scenarios | Task 1 |
| § "Acceptance criteria" L36-L51 | Actual summaries, pruning, downstream behavior, and report evidence | Task 4, Task 5, Task 6 |
| § "Acceptance criteria" L36-L51 | Correct-source recovery and subsequent answer use required | Task 3, Task 4 |
| § "Acceptance criteria" L36-L51 | Retain unchanged-product baseline with provenance and failures, linked from guide | Task 5, Task 6, Task 7 |
| § "Acceptance criteria" L36-L51 | Report phase usage/time/cost without invented zeros | Task 2, Task 4, Task 5 |
| § "Acceptance criteria" L36-L51 | Same-key candidate comparison names experiment and overhead | Task 5 |
| § "Acceptance criteria" L36-L51 | Baseline first for both named future product changes | Task 7 |
| § "Acceptance criteria" L36-L51 | Explicit paid command; existing unit command stays offline | Task 1, Task 5, Task 7 |
| § "Acceptance criteria" L53-L53 | Expected/observed repeat evidence, source outcomes, corpus SHA/hash, intended change and workflow record | Task 5 |
| § "Layout" L83-L83 | Create listed harness/corpus/test surfaces and scripts; no production imports/edits or deletion | Task 1, Task 2, Task 3, Task 4, Task 5 |
| § "Layout" L83-L83 | Amend documentation surfaces | Task 7 |
| § "Pinned configuration (`eval/config.ts`)" L89-L98 | Pinned subject/prompt/thinking, summarizers (including the user's chosen luna id), judge, runs, concurrency, literal settings and retry constants | Task 1 |
| § "Pinned configuration (`eval/config.ts`)" L100-L100 | Product defaults cannot shift literal pipeline; intentional settings changes require re-baseline | Task 1, Task 7 |
| § "Pinned configuration (`eval/config.ts`)" L102-L102 | Exact key and full metadata, SDK-version warning only, mismatch refusal with both headers | Task 5 |
| § "Pinned configuration (`eval/config.ts`)" L104-L104 | Frozen judge identity without temperature or determinism claim | Task 3, Task 7 |
| § "Scenario shape (`eval/scenario.ts`)" L109-L127 | Typed history/probe/mechanical/oracle/expected scenario schema | Task 1 |
| § "Scenario shape (`eval/scenario.ts`)" L130-L130 | Complete traversable seeds, linked call/results and fixed ids | Task 1 |
| § "Scenario shape (`eval/scenario.ts`)" L130-L130 | Protected-path avoidance, eligible batch sizes, invented and hygienic fixtures | Task 1 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Middle 12k-result fact requires original evidence and reply value | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Unverified cause remains unverified | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Refuted explanation ruled out with its observation | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Unrelated fix failure does not disprove hypothesis | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Three interleaved task-A attempts recovered and identified | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Correction used, rejected quotation allowed | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Approved step offered/performed, ask before unapproved step | Task 1, Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Objective literal gates, semantic judgment against oracle | Task 3 |
| § "Scenario shape (`eval/scenario.ts`)" L136-L146 | Resolve aliases, match returned block/evidence, complete recovery before final reply and require value | Task 3 |
| § "One job (`eval/session.ts`)" L150-L152 | Child process owns settings/cwd/env and no copied credentials | Task 4 |
| § "One job (`eval/session.ts`)" L153-L153 | Operator auth/models paths and transparent model/context/status/raw-usage/time observation; verified priced finite cost estimated, otherwise unavailable, never provider | Task 2, Task 4 |
| § "One job (`eval/session.ts`)" L154-L155 | Only extension loaded, no discovery, loader systemPromptOverride supplies pinned prompt, no session systemPrompt option; bind lifecycle and assert exact tools/prompt | Task 4 |
| § "One job (`eval/session.ts`)" L156-L156 | Summarized metrics, batch count, id coverage and successful pinned model required | Task 4 |
| § "One job (`eval/session.ts`)" L157-L157 | Prove actual outgoing stubs/summary and absent raw input; collect phase metrics and behavior | Task 4 |
| § "One job (`eval/session.ts`)" L158-L160 | Dispose and keep complete job records in temporary directory | Task 4 |
| § "Scoring (`eval/judge.ts`)" L164-L164 | Mechanical checks first and named failures, then same-runtime frozen oracle judge without history/temperature | Task 3 |
| § "Scoring (`eval/judge.ts`)" L164-L164 | Strict pass/reason JSON, one parse retry then error | Task 3 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L168-L168 | Clean committed tree and authenticated pinned models before jobs/artifacts | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L170-L170 | Bounded cross-product pool; fresh-directory retries with attempts and extra overhead | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L172-L172 | Mode/change/summarizer/runs flags and bare-command examples/nonzero exit | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L174-L174 | Printed/retained header contains complete identity, scoring, versions, retries and estimates | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L176-L176 | Case tests/expected/observed evidence and per-repeat verdict/reason/recovery/excerpt/tools | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L176-L176 | Unknown/estimated metrics, totals, and temporary full traces | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L178-L178 | Baseline writes no reports on errors, retains failures with exit zero | Task 5 |
| § "Orchestration and output (`eval/run.ts`, `eval/report.ts`)" L178-L178 | Same-key comparison has all-case markers, repeat reasons, overhead, errors, drop summaries and nonzero exit | Task 5 |
| § "Documentation and workflow rule" L182-L182 | Guide purpose, seven cases, key, commands, report reading and branch baseline links/estimates | Task 7 |
| § "Documentation and workflow rule" L182-L182 | Sampling variance, confirmation rerun, and key-change re-baseline rule | Task 7 |
| § "Documentation and workflow rule" L184-L184 | AGENTS trigger paths, commit-body record, baseline-first named changes, Layout and Testing | Task 7 |
| § "Baseline production in this branch" L188-L188 | Harness commit, clean real baseline, reports next; preserve failures and repair only harness errors | Task 6 |
| § "Errors and edge cases" L192-L193 | Dirty tree or missing model/auth aborts without jobs or writes | Task 5 |
| § "Errors and edge cases" L194-L196 | Extension/isolation/no-flush/not-pruned/summarizer/fallback are errors, never behavioral failures | Task 4 |
| § "Errors and edge cases" L196-L196 | Observer catches summarizer errors/fallback, baseline refuses, compare separates | Task 2, Task 5 |
| § "Errors and edge cases" L197-L197 | Invalid judge JSON retries once then errors | Task 3 |
| § "Errors and edge cases" L198-L202 | Retry only provider 429/transport, then provider error | Task 5 |
| § "Errors and edge cases" L198-L202 | Unknown metrics unavailable, derived cost estimated | Task 5 |
| § "Errors and edge cases" L199-L199 | Preserve missing measurement and catalog-estimated provenance | Task 2 |
| § "Errors and edge cases" L198-L202 | Mismatched key/runs rejected with both headers | Task 5 |
| § "Errors and edge cases" L198-L202 | Single-model baseline only writes its own report; non-pinned baseline runs rejected | Task 5 |
| § "Errors and edge cases" L203-L203 | Test middle fact outside clipping windows | Task 1 |
| § "Errors and edge cases" L204-L204 | Eval writes confined to one temp root except baselines; credentials never copied into job dirs, logged, or written into eval artifacts; runtime OAuth refresh of operator auth.json unchanged and excluded from eval writes | Task 2, Task 4, Task 5, Task 6 |
| § "Tests" L208-L208 | Eval tests offline and separate from unchanged existing unit/release gate | Task 5, Task 7 |
| § "Tests" L210-L214 | Corpus coverage/hygiene/position/eligibility tests | Task 1 |
| § "Tests" L210-L214 | Seed traversal, complete fields and call/result linkage tests | Task 1 |
| § "Tests" L215-L215 | Real offline lifecycle with stub runtime, disabled/trivial controls, exact tools and outgoing stubs | Task 4 |
| § "Tests" L216-L216 | Observer raw usage and fallback tests | Task 2 |
| § "Tests" L217-L218 | Recovery trace edge cases and oracle/parse routing tests | Task 3 |
| § "Tests" L219-L221 | Availability/report/comparison/CLI/preflight/retry/write-policy tests | Task 5 |
| § "Tests" L222-L222 | Committed paid reports are live path evidence | Task 6 |
| § "Tests" L223-L223 | Existing manifest test command assertion | Task 1 |
| § "Tests" L224-L224 | Document process observable in commit body | Task 7 |
| § "Documentation impact" L230-L232 | New eval operations guide | Task 7 |
| § "Documentation impact" L230-L232 | Amend AGENTS, README routing and Unreleased changelog | Task 7 |
| § "Documentation impact" L230-L232 | Update invalidated Layout and Testing units | Task 7 |
| § "Out of scope" L236-L236 | No production prompt/clipping/fusion/enrichment changes | waived: explicitly excluded product work |
| § "Out of scope" L236-L236 | No loop/stop policy, general platform, or paid CI execution | waived: explicitly excluded machinery |
| § "Out of scope" L236-L236 | No additional pins or default repetitions; no adjacent pointer repair | Task 1, Task 5, Task 7 |
