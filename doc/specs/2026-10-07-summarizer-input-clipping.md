# Summarizer input window: head + tail instead of head-only crop

**Goal:** Summaries stop dropping facts that sit past the first 2,000 characters of a tool result, so the model stops re-reading files and re-querying for things the summary should have carried.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Date:** 2026-10-07
**Status:** proposed

## Problem

`serializeBatchForSummarizer` (`src/batch-capture.ts:221-246`) hands each tool result to the summarizer LLM as its first 2,000 characters plus ` ...[N chars truncated]`. The constant `MAX_CHARS = 2000` dates from the v1 commit `b4cf765` and has no spec, no PRUNING.md rationale, and no setting. A fact past that point - a compiler error at the end of a test run, the newest rows of a `git log`, the closing lines of a file read - never reaches the summarizer, so the summary either omits it or states the opposite ("the query returned no output").

Observed in a real session (gridstrong dashboard, 2026-10-07, 206 summarized batches): the needed error sat at character 4,101 of a 5,175-char result and three git rows sat at characters 2,163-2,413 of a 2,413-char result; both were absent from the serialized input, and the model wrote "The summaries keep truncating the one thing I need. Pulling the exact lines directly." and later "I'm burning time locating the file-selector recorder via summaries."

Results at or above `spillThreshold` (65,536 by default) are spilled to a sidecar and bypass the serializer (spill spec `doc/specs/2026-06-02-oversized-output-spill.md`, "No summarizer path"), so under the default threshold and a successful sidecar write the affected band is results between 2,001 and 65,535 characters. A sidecar write failure leaves the result inline for the normal flush (PRUNING.md "Eager single-result spill"), where the window applies like to any other result.

A second mechanism compounds the symptom in that session: with `autoBudgetThreshold: 0.4` on a context already past the 300k `MAX_BUDGET_WINDOW` ceiling, every tool-using `turn_end` flushes (`index.ts:885-1017`), so a fresh read is stubbed before the next assistant turn consumes it. That is a configuration lever (`autoBudgetThreshold: null`, keeping `budgetTurnDelta` and `frontierGapThresholdTokens`), the budget trigger is opt-in (default `null`), and the recovery-grace spec (`doc/specs/2026-07-06-recovery-grace-window.md`, "No global grace window") deliberately left ordinary results unprotected. It stays out of scope here.

Framing: kept - checked the serializer, the summarizer prompt and limits (`src/summarizer.ts`), the `turn_end` gate, pruner Phase 1, the recovery-grace, spill, and budget specs. The crop is the root cause of the dropped facts; fixing it also lowers the cost of mechanism 2 because the summary then carries the tail.

## Acceptance criteria

none - no ticket

## Design

### Window function

`serializeBatchForSummarizer` keeps its signature and its single caller (`src/summarizer.ts` `summarizeBatch`). The per-result crop becomes a head + tail window:

| Raw result length `L` | Serialized form |
|---|---|
| `L <= 8000` | the whole result, unchanged |
| `L > 8000` | first 4,000 chars + ` ...[N chars elided]... ` + last 4,000 chars, where `N = L - 8000` |

The 8,000 cap counts retained source characters; the marker (23 chars plus the digits of `N`) is added on top, so a windowed result body is `8,000 + 23 + digits(N)` chars - 8,024 for `L = 8001`, 8,029 through `L = 1,007,999`, 8,030 from `L = 1,008,000` (reachable only when a spill-sized result stays inline) - and, for `L` just above 8,000, a few chars longer than the raw result. The rule is the table, with no special case: empty and whitespace-only results follow the same length test, as today's crop does.

Constants: `HEAD_CHARS = 4000`, `TAIL_CHARS = 4000`, replacing `MAX_CHARS`. They are fixed, not settings: the fixed total is the per-result cost ceiling on summarizer input and the guarantee this spec makes. The marker text changes from `truncated` to `elided` because the omitted region is now the middle, and the summarizer prompt needs a word it can key on.

The window applies to `tc.resultText` after `extractToolResultText` has rendered it (image marker lines first, then text), exactly where the crop applies today, so `[[N:toolname]]` labels, `Tool: name(args)` lines, image markers, and block ordering are untouched. Both cuts slice at UTF-16 code-unit boundaries (`String.prototype.slice`), as the current crop does; a cut inside a surrogate pair leaves a lone surrogate at the cut, and this spec adds no boundary adjustment.

### Summarizer prompt

`SYSTEM_PROMPT` (`src/summarizer.ts:15-25`) gains one sentence after the image-marker sentence:

> A result containing ` ...[N chars elided]... ` had its middle removed before you saw it: summarize the head and tail you can see, and never report the elided region as empty or absent.

`RANGE_SYSTEM_PROMPT` is unchanged; range fusion consumes summaries, not raw results.

### Comment at `extractToolResultText`

The doc comment at `src/batch-capture.ts:58-62` ("Markers lead because the summarizer input keeps only the first 2,000 result chars") becomes "Markers lead so they survive the summarizer's head + tail window."

### What does not change

Capture, eager spill (a successfully spilled result never reaches the serializer), the indexer records (full `resultText` is stored; `context_tree_query` renders it under its existing head-truncation limits, unchanged), `pruneMessages`, the `minBatchChars` skip, the oversized-summary guard (`index.ts:517`: a summary longer than its raw batch is dropped and the raw kept), and every setting. No config, README, or `commands.ts` surface changes.

### Context-size guarantee

The serialized text reaches only the summarizer model; the code paths that put text into main context (summary injection, stub replacement, the oversized guard) do not change. What is guaranteed: a summary can never exceed its raw batch (oversized guard), and the prompt's 1-3-bullets-per-call instruction stays. What is not guaranteed: an unchanged summary size - the prompt copies error strings verbatim, and tail errors the summarizer now sees are exactly the strings a summary should carry, so summaries of affected results may grow by those facts. The acceptance bound is a before/after measurement of `summaryCharCount / rawCharCount` across summarized `context-prune-frontier` diagnostics (baseline on the gridstrong session: 7%, 258k / 3.69M): the ratio measured on a live session after the fix ships stays under 10%. The measurement needs real summarizer calls, so it is a post-ship observation, not a plan or verify gate.

Summarizer-call input grows by at most 6,000 chars plus the marker-length difference (2-7 chars) per windowed result, about 1,500 tokens. The ceiling is per result, and batches have no tool-call cap, so per-flush input grows with batch size. Measured on the gridstrong session (924 tool results, 147 above 8,000 chars; flush with the most calls: 40): the largest serialized flush goes from about 62k chars today to about 186k chars (roughly 16k to 47k tokens), within the context window of the models the summarizer runs on (default: the active model). No per-batch clipping is introduced; that would be a separate decision. A flush that still overflows the summarizer's window fails as `transient` and engages the existing fallback controller, as any oversized request does today.

### Approaches considered

- Raise `MAX_CHARS` (reuse-only): keeps the head-only shape, so tail-placed errors and git rows are still lost at any cap below the result length. Rejected: extends the v1 crop, which is the debt.
- Head + tail at a fixed 8,000 total (chosen): both observed failures land in the tail window with margin; cost ceiling preserved; no new setting.
- Uncapped input (bounded only by `spillThreshold`): nothing lost, but a 64k-char result costs about 16k summarizer tokens per flush, and budget-triggered sessions summarize every turn; raises the chance of `stopReason: "length"` summaries, which `isUsableSummary` discards. Rejected on cost.

The choice flips to a larger split (not to uncapped) if sessions show facts routinely in the middle of long outputs.

## Errors and edge cases

- `L = 8000` passes whole; `L = 8001` is windowed with `N = 1`, producing an 8,024-char body (4,000 + 24-char marker + 4,000), 23 chars longer than raw. The marker appears only when at least one character is elided.
- The function stays pure and total; no new failure exits. The summarizer's two existing error exits (`isUsableSummary` rejecting empty or `length`-stopped output; the oversized guard) are unchanged.
- A result that is exactly an image-marker list plus short text is below the window and unaffected.

## Tests

`src/batch-capture.test.ts` has no coverage of the current crop; coverage is net-new, co-located, `bun test src/`:

1. Result of 8,000 chars serializes whole; no marker.
2. Result of 8,001 chars: output is first 4,000 + ` ...[1 chars elided]... ` + last 4,000.
3. Result of 20,000 chars: head is `raw.slice(0, 4000)`, tail is `raw.slice(16000)`, marker reads `12000 chars elided`.
4. A sentinel placed in the last 100 chars of a 5,175-char result appears in the serialized output; a sentinel placed at char 10,000 of a 20,000-char result does not (the regression shape from the observed session).
5. For lengths 0, 1, 7,999, 8,000, 8,001, 65,535: the result body (the text after `Result (OK): `, not the `[[N:toolname]] Tool:` wrapper) equals the raw text when `L <= 8000` and equals `raw.slice(0, 4000) + marker + raw.slice(-4000)` when `L > 8000`; body length exceeds raw by at most the marker length.
6. `[[N:toolname]]` labels and `Tool:` lines are unchanged for windowed results (extends the existing label tests).
7. `src/summarizer.test.ts`: through `summarizeBatch` and the existing `seenInput` stream mock, the system prompt sent to the model contains `chars elided` and the instruction not to report the elided region as empty (`SYSTEM_PROMPT` stays module-private).

Existing suites (`summarizer-wiring`, `pruner`, integration) run unchanged; they guard the injection paths, not summary size. The size bound is the diagnostics ratio check in "Context-size guarantee", observed on a live session after ship.

## Documentation impact

Per `reference/documentation-impact.md`:

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` - new `### Summarizer input window` subsection under `## Pre-flush Pipeline & Safeguards` (after `### Eager single-result spill`, with a matching TOC row), recording the head + tail shape, the 4,000/4,000 split, and why uncapped input was rejected (non-obvious rationale: cost ceiling vs tail-placed facts); `CHANGELOG.md` - a `## [Unreleased]` / `### Fixed` entry written with the change (the release promotes it)
- Derived / memory docs invalidated: none

## Out of scope

- Protecting fresh results from budget-triggered stubbing (mechanism 2). Config lever: `autoBudgetThreshold: null`. A future spec would amend the recovery-grace spec's "No global grace window" decision.
- A setting for the window size.
- Reconciling the window with `spillThreshold`.
- Any change to `context_tree_query`, the indexer, or spill.

## Open questions

none
