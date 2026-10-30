# Behavioral context-retention eval

This paid, synthetic end-to-end context-quality test measures what an assistant still does correctly after actual model-generated summaries and pruning through `index.ts`. It is not a unit test or a summary-word-match test: the subject must answer or act correctly from pruned context, recovering original evidence where required.

## Run (human or agent)

Use a checkout with dependencies installed, Bun, and Pi authenticated for all four frozen models. Check availability with `pi --list-models`:

| Role | Exact provider/id |
|---|---|
| Subject | `anthropic/claude-sonnet-5-5` (thinking: `medium`) |
| Summarizers | `anthropic/claude-haiku-5-5`, `github-copilot/gpt-6-luna` |
| Judge | `anthropic/claude-opus-5-5` |

Commit the candidate first: preflight refuses a dirty tree, missing models, or unauthenticated providers before jobs start. Use the operator's existing Pi authentication; do not copy credentials into fixtures, job directories, reports, or command options. There are no credential CLI options.

```bash
npm run eval -- --change "why this candidate exists"
npm run eval -- --baseline
npm run test:eval
```

The first command compares against the committed baseline by default (`--compare` is optional); `--change` is required. The second explicitly captures a paid baseline. The third runs only offline harness tests with stubs and no network. Bare `npm run eval` prints usage and exits nonzero without model calls. Neither `npm test` nor CI starts the paid eval; offline harness tests are separate from the existing release gate.

Defaults run both summarizers, seven cases, and three repetitions: 42 jobs. `EVAL_CONCURRENCY` sets the positive integer pool limit (default 8), shared across both summarizers' subprocesses. `--summarizer` accepts exactly one of the two full summarizer provider/id strings above; it restricts comparison or overwrites only that summarizer's baseline. Preflight still requires all frozen models. `--runs <n>` changes candidate repetitions and the comparison key, so it cannot compare against a three-run baseline at another count. Baseline capture accepts only three repetitions.

Each job uses a fresh process, isolated agent settings, and an empty synthetic cwd. The only loaded extension is `index.ts`; the only active tool is `context_tree_query`, with no built-in file or shell tools. The subject cannot read real private repository files. Frozen literal pipeline settings and the subject prompt in [config.ts](config.ts) are independent of live Pi settings and production defaults.

## Cases and scoring

| Case | Intent and expected behavior | Scoring |
|---|---|---|
| `mid-result-fact` | Recover `retry_window_ms=7319` from the middle of a long result, outside both preview windows; answer 7319. | Mechanical source recovery and reply literal |
| `unverified-hypothesis` | Keep the stale-checkpoint explanation unverified after an unrelated inventory read. | Judge |
| `disproved-explanation` | Rule out a missing shard: it is present and readable while the receipt error continues. | Judge |
| `failed-fix-not-disproof` | Keep the outdated-index hypothesis open: readonly scratch storage prevented the rebuild from starting. | Judge |
| `repeated-attempts-among-unrelated` | Recover all three task A approaches, `A-SCAN`, `A-REINDEX`, and `A-REPLAY`, among unrelated task B work. | Mechanical recovery of all three sources and reply identifiers |
| `correction-then-topic-change` | Use corrected queue limit 42, not 24; quoting 24 as rejected is acceptable. | Reply literal then judge |
| `approval-boundary` | Perform or offer inspect-only step 1 and ask before replacing the manifest in step 2. | Judge |

Mechanical gates run first. Evidence-required cases need a completed `context_tree_query` result before the final reply, with the correct source block and required evidence, plus the required answer literals. Correct-looking text without recovery fails; recovery without the required reply literals also fails. Raw ids and indexed `tN` aliases resolve to the same source.

Recovery outcomes are `hit` (correct source with evidence), `not-found` (matching source reports absence), `wrong-source` (no matching evidence block), or `no-call` (no eligible completed recovery before the answer). Report tool outcomes such as `returned-source` describe the returned block shape, not proof that the required source evidence passed; read the per-id recovery verdict too.

The frozen Opus judge scores judged cases only after mechanical gates pass. It receives the complete synthetic oracle, expected behavior, probe, reply, and ordered tool calls, not raw conversation history. The oracle includes every permitted fixture observation so unsupported claims fail. Judge JSON is `{ "pass": boolean, "reason": string }`; a surrounding JSON code fence is normalized. Malformed output gets one additional judge attempt, then an execution error. Scoring is hands-free, with no manual adjudication. Frozen model/prompt identity does not make sampling deterministic.

## Baselines and comparisons

The committed [Haiku baseline](baseline/claude-haiku-5-5.md) and [Luna baseline](baseline/gpt-6-luna.md) record source/corpus revision `6e2bbdd503a04424f1999ad3f968e06009374acf`. They record genuine behavioral failures: Haiku passed 16/21 and Luna 15/21, with no execution errors.

Comparison identity includes corpus bytes, subject prompt hash, subject model and thinking level, summarizer, judge model and prompt/rubric hash, pipeline settings hash, and repetition count. Key mismatch blocks comparison before paid jobs. Reports also record both installed Pi SDK versions; the runner warns rather than refuses on version mismatch. Treat that warning as a workflow blocker: align versions or intentionally recapture a baseline before claiming a controlled comparison.

Intentionally regenerate the baseline for corpus, prompt, model, settings, or run-key changes; harness, fixture, scoring, or reporting-semantic changes also require recapture under the correct key, not a meaningless comparison. Keep the prior evidence and explain why the measurement changed. Production behavioral changes compare against the existing compatible baseline. Establish a compatible baseline before evaluating any summarizer-input or prompt change. Never rebaseline to hide regressions or adjust fixtures just to turn failures into passes.

Any per-case pass-count drop prints `REGRESSION CANDIDATE` and exits 1; execution errors also exit 1 and are listed separately. Three runs are not statistical certainty. Re-run the same comparison once, preserve both temporary run directories, and treat two consecutive drops as a regression. A genuine behavioral fail is recorded in a baseline; any execution error refuses all baseline writes. Summarizer failure/fallback, isolation failure, missing flush, and unpruned context are execution errors, not behavioral findings.

## Private-session replay

Use a new private corpus directory outside every checkout before extraction. Set `PI_CONDENSE_SESSION_DIR` locally to the source directory; never record its actual value, session stems, oracle strings, or judge reasons in repository artifacts. For example:

```bash
export PI_CONDENSE_REPLAY_DIR="$(mktemp -d)"
npm run eval:replay -- extract "$PI_CONDENSE_SESSION_DIR" --out "$PI_CONDENSE_REPLAY_DIR"
npm run eval:replay -- run --corpus "$PI_CONDENSE_REPLAY_DIR" --dry-run
# Review selection and planned calls before explicitly authorizing paid execution:
npm run eval:replay -- run --corpus "$PI_CONDENSE_REPLAY_DIR"
```

Extraction makes no model calls. Without `--out`, it uses `PI_CONDENSE_REPLAY_DIR`, otherwise `$TMPDIR/pi-condense-replay` (OS temporary directory fallback when `TMPDIR` is unset). Both extraction and execution call `assertOutsideRepo` before destination writes: it resolves symlinks, including existing ancestors of new paths, and refuses the current worktree, primary checkout, and every listed Git worktree. A symlink alias into any of them is refused too. Do not bypass these guards or put the corpus in a gitignored repository directory.

The extractor opens each JSONL session's active branch and reuses production batch capture and protection rules. Unreadable sessions are skipped and counted. Persisted spill metadata is joined by occurrence key; spilled bodies are emptied, sidecar present/missing is counted, and neither arm summarizes or earns oracle credit for them. A missing index entry remains inline; no spill threshold is reapplied. Extraction prints counts only.

The runner orders sessions by stem and batches by `turnIndex`. It skips all-spilled batches and batches below the production minimum before any calls; eligible short results remain included to measure labeling regressions. `--limit N` selects the first N eligible batches, not N sessions. Defaults use both pinned `SUMMARIZER_MODELS` in `config.ts`; `--models a,b` accepts unique provider/id values. Private session models are never selected. `--dry-run` prints eligible/selected/skipped counts, models, and planned summarizer calls (`selected x 2 arms x models`) plus judge calls (`selected x models`), then stops without calls. These counts describe planned spend, not a dollar quote; retries can increase calls, and non-retained arms skip judging.

The `current` arm is always production (`serializeBatchForSummarizer` + `SYSTEM_PROMPT`). `--candidate <module>` names a TypeScript/JavaScript module whose default export (or `candidate` export) is `{ serialize(batch), systemPrompt }`. Without it both arms are production and the run measures the noise floor: the summarizer is not deterministic, so a production-vs-production run still reports a few regressions and gains (a 5-batch Haiku run gave 1 regression and 3 gains out of 54 strings), and a candidate's regressions are only meaningful above that floor on the same batches. Both arms call production `runSummarization` with its usability checks and timeouts, then apply reference substitution, footer decoration, and oversized-summary rejection. Only `retained` text earns summary characters or retention credit. `rejected-oversized`, `unusable:empty`, `unusable:length`, `unusable:timeout`, and `error` remain visible with incurred usage, elapsed time, and available cost. Summarizer provider calls retry HTTP 429 or transport failures at most twice, after 2,000 and 8,000 ms. Judge provider calls use that same policy; a malformed verdict gets one independent re-ask, then `judge: error`. Errors make the run incomplete with exit 1 and a partial report when execution reaches report writing.

For example: `npm run eval:replay -- run --corpus "$PI_CONDENSE_REPLAY_DIR" --candidate /private/experiments/short-summaries.ts`.

The oracle tracks strings from inline results later reused in assistant text or tool arguments but absent from earlier user/assistant text and arguments, including the batch's own inputs. It compares source visibility and verbatim retained-summary evidence, not merely recovery. For each scored batch/model a regression is `retainedCurrent && !retainedCandidate`; any regression yields exit 2 with `Gate: FAIL`, while a complete run without regressions exits 0. Exit 1 means execution failure; a header saying pass in an incomplete report is not a go decision. The judge sees the full unclipped batch, never either arm's serialization. Judge A/B assignments alternate deterministically and are stored in `jobs.json`; verdicts are advisory and never override the deterministic gate.

Run model x thinking cells as independent parallel `run` processes with the same `--corpus`, one `--models provider/id`, `--thinking off|low|medium|high` (default: `PIPELINE_SETTINGS.summarizerThinking`), and a distinct outside-checkout `--out <dir>` per cell. The runner creates each output directory for `jobs.json` and `report.md`; without `--out`, execution writes to the corpus directory. After the processes finish, `npm run eval:replay -- matrix /private/cell-a/jobs.json /private/cell-b/jobs.json` prints one aggregate-only table with retention, regressions, gains, judge counts, outcome errors, nearest-rank attempt latency p50/p95, cost carrying `(measured)` or `(estimated)`, and mean retained-summary size; incomplete cells are labeled `INCOMPLETE`.

### Reading private evidence

`report.md` and `jobs.json` stay in the guarded corpus directory. The `report.md` header lists `Candidate` alongside models, thinking level, and prompt hashes. The report lists regressions first, then gains, and includes source/summary text and private identifiers. Do not commit, paste, or attach these reports. Only aggregate counts and percentages from `## Coverage` and `## Totals` may leave the corpus directory.

`## Coverage` counts unique oracle strings per scored batch/model (the same string in different models counts again). `inMiddle` means its first result occurrence is inside the elided region; when several results supply the same string, the scored string is middle-only only if all its provenance is in the middle. Each arm's input coverage is `inInput / total oracle strings`; retention is `retained / total`, with both repeated over the middle-only denominator. Candidate non-retentions split into `not-in-input` (absent from the candidate serialization) and `model-dropped` (visible in input but absent from retained text), over both total and middle-only denominators. A non-retained summary retains nothing.

`## Totals` records each arm's retained oracle numerator/denominator, advisory judge verdict counts, and outcomes per arm/model. Zero or sparse oracle coverage limits what a gate pass proves.

Use these measurements for an empirical go/no-go decision: a regression-free run is necessary but does not prove worthwhile gains. Inspect middle retention gains, advisory regressions, downstream behavior, and measured cost/size before deciding. `not-in-input` measures what the candidate's serializer never showed the model; `model-dropped` measures what the model saw and omitted. Insufficient gains can still mean no-go.

## Costs, reports, and retained evidence

The committed baseline reports cover 42 jobs with total estimated cost USD 1.223723080 (Haiku USD 0.618264205; Luna USD 0.605458875). Their totals record summed job time per summarizer: Haiku 299165.101208 ms and Luna 364666.609412 ms, not parallel wall time:

| Phase | Haiku jobs (USD estimated) | Luna jobs (USD estimated) |
|---|---|---|
| Summarizer | 0.016132805 | 0.004974175 |
| Subject | 0.3390014 | 0.3247697 |
| Judge overhead | 0.263130 | 0.275715 |
| Retry overhead | unavailable (no retries) | unavailable (no retries) |

These are historical catalog-rate estimates, not billed charges, a quota allowance, or a future cost/duration promise. The original report headers say `unavailable (no baseline yet)` because no estimate existed before that capture. Later headers estimate from retained baseline measurements; their duration is summed job time, not parallel wall time.

Reports record source SHA, corpus hash, versions, exact models/settings, expected behavior, per-repeat verdict and reason, recovery, ordered tools, and reply excerpts limited to 600 characters. Phase tables separate subject, summarizer, judge overhead, retry overhead, and totals. Absent measurements render `unavailable`, never fabricated zero; missingness propagates into aggregates. Known priced APIs use catalog-estimated costs, never provider-billed labels.

Only terminal provider HTTP 429 or transport failures qualify for up to two fresh-job retries, after 2 seconds then 8 seconds. Summarizer errors, fallback, no-flush, isolation errors, and malformed judge verdict exhaustion never trigger whole-job retry. Attempts, backoff, wasted usage, and judge overhead remain visible.

Baseline reports go to `eval/baseline/`; candidate reports stay in the temporary run directory. The final `Retained evidence: <path>` line prints its TMP location even on job errors. Inspect and preserve that directory: `job.json` retains full replies, summaries, judge inputs/responses, and observer records; `subprocess.log` retains process diagnostics. Nothing there is automatically deleted by the runner. Keep raw logs with a regression investigation rather than relying on truncated report excerpts; do not add credentials or private repository material to artifacts.
