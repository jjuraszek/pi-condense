# Spec: per-bullet ref mapping in prune summaries

Date: 2026-07-04
Branch: `per-bullet-refs`
Issue: #2 (Per-bullet ref mapping in prune summaries (recovery UX))

## Problem

A prune summary lists its recovery refs as a flat footer appended by
`formatSummaryToolCallRefs` (`src/summary-refs.ts:46`):

```
---
**Summarized tool refs**: `t12`, `t3`, `t7`
Use `context_tree_query` with these refs to retrieve the original full outputs.
```

The refs are positional against the summarized batch's tool-call order, but no
per-bullet body carries its own ref. When the model wants to recover one tool's
raw output it must guess which footer ref maps to the bullet it just read, then
call `context_tree_query`. The mapping exists deterministically in the code
(both the serializer and the ref allocator iterate the same post-dedup
`batch.toolCalls` in the same order) but is never surfaced onto the bullet, so
the one datum that would make recovery a single hop is discarded at render time.

The roast on issue #2 (two reviewers) killed the originally-proposed
`context_search` FTS tool and converged on this 1:1 bullet->ref mapping as the
only real gap: "put the ref on the bullet, not build a search tool." The roast
rationale, inlined so an implementer needs no issue access: a search tool adds a
new tool surface, spill/sidecar coverage, and match-cap handling for payoff a
deterministic per-bullet ref already delivers; the model is not ref-blind (the
prompt already orders paths/ids/errors into the body and refs are in-context) -
the fix is to attach the ref to the bullet. No new tool, no index.

## Goals

- Each per-tool block in a per-batch prune summary carries its own recovery ref
  inline (`` `t12` ``), so the model recovers a specific tool's raw output in one
  hop instead of eyeballing a flat footer.
- The existing footer stays verbatim as an always-correct fallback (satisfies
  issue #2 AC "footer preserved").
- Deterministic mapping: number->shortId is pure index arithmetic on the shared
  `batch.toolCalls` order; the LLM only copies a label, it never invents a ref.
- Graceful degradation: any missing, malformed, out-of-range, **or
  tool-name-mismatched** label leaves the affected bullet ref-less (footer still
  covers it) rather than emitting a broken *or confidently wrong* token.

## Non-goals

- **No `context_search` / FTS / recovery-search tool.** Killed in the roast;
  explicitly out of scope.
- **No change to ref allocation, shortId format, or `context_tree_query`.**
  `buildShortToolCallRefs` (`t${startIndex+offset}`) and the indexer's
  `allocateSummaryRefs` are untouched.
- **No new config knob.** Decoration is unconditional; there is no opt-out.
  Rationale: it strictly improves recovery UX, degrades to today's footer when
  the LLM omits a label, so a knob gating an unconditional-improvement would be
  dead weight (YAGNI).
- **No separate range-summary implementation.** Range fusion inherits inline
  refs for free (see "Range-summary propagation"); we add no code there beyond a
  confirming test.

## Mechanism

The change rests on an ordering invariant that already holds end-to-end:
`serializeBatchForSummarizer` (`src/batch-capture.ts:147`) and
`allocateSummaryRefs` (`src/indexer.ts`, via `buildShortToolCallRefs`) both
iterate the **same** post-dedup `batch.toolCalls` array in the **same** order.
So the serialized tool at 1-based position `N` maps deterministically to
`refs[N-1].shortId`. Two transforms that could have desynced it do not:

- **Dedup** rewrites `batches[i] = { ...batch, toolCalls: remaining }` in
  `index.ts` *before* both serialize and allocate run, so both observe the
  identical filtered array.
- **agent-message merge** (`groupBatchesByMode`, `src/batch-capture.ts`)
  concatenates `toolCalls` in order into one `CapturedBatch`; refs are allocated
  over that merged array. Numbering stays 1..N over the merged whole.

### Touch point 1 - label the serialization (`src/batch-capture.ts`)

In `serializeBatchForSummarizer`, prepend `[[N:toolname]] ` (double-bracket
label carrying position **and** tool name + one space) immediately before
`Tool:` at the start of each tool block, so the model can copy (not count) it.
`N = index + 1` from the existing `batch.toolCalls.map((tc, index) => ...)` loop;
`toolname` is `tc.toolName` (already in scope). The name is carried so the
substitution step can *validate* the model's echoed label against the actual
tool at that position (see Touch point 3). Nothing else in the block changes.
Concrete before/after (block for the first tool):

```
Before:
Tool: read({"path":"a.ts"})
Result (OK): ...

After:
[[1:read]] Tool: read({"path":"a.ts"})
Result (OK): ...
```

The change to the returned block string is exactly:
``return `[[${index + 1}:${tc.toolName}]] Tool: ${tc.toolName}(${argsJson})\nResult (${status}): ${resultText}`;``

### Touch point 2 - one instruction line (`src/summarizer.ts`)

`SYSTEM_PROMPT` is concatenated as the leading text of the single user message
(`summarizeBatch`: `SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + ...`;
there is no separate system role in this call path), so adding a line to the
constant lands it in the message the model reads. Append one paragraph to
`SYSTEM_PROMPT` **after** the existing final paragraph (`Keep each tool call to
1-3 bullet points. ... Be concise.`), and only there - `RANGE_SYSTEM_PROMPT` is
left untouched. Exact text to add:

> Begin the first bullet of each tool call with that tool's `[[N:toolname]]`
> label, copied verbatim (both the number and the name) from its line in the
> input, as the plain, first thing on the line (no bold, backticks, or list
> numbering around it). Do not renumber, rename, or invent labels; if you skip a
> tool, skip its label too.

"Copy the label" is a far more reliable ask than "count correctly": if the model
skips a tool (the prompt already says "Skip calls that succeeded with nothing
reusable to record"), copying keeps every emitted label pointing at the right
source, whereas a running counter would silently shift.

### Touch point 3 - substitute inline (`src/summary-refs.ts` + `index.ts`)

New pure function in `src/summary-refs.ts`:

```ts
export function substituteInlineRefs(
  text: string,
  refs: SummaryToolCallRef[],
  toolNames: string[],
): string
```

It rewrites line-leading `[[N:name]]` labels to the backtick-wrapped shortId
using `refs[N-1]`, **after validating** that the echoed `name` matches
`toolNames[N-1]` (comparison is trimmed + case-insensitive). `refs` and
`toolNames` are positionally aligned to the same `batch.toolCalls` order
(`refs` from `buildShortToolCallRefs(batch.toolCalls.map(tc => tc.toolCallId))`,
`toolNames` from `batch.toolCalls.map(tc => tc.toolName)` - the exact array
`makeSummaryDetails` already builds). `SummaryToolCallRef` carries no tool name,
so `toolNames` is passed as a third argument rather than read off `refs`.

Note `SummaryToolCallRef.shortId` **already includes** the `t` prefix
(`buildShortToolCallRefs` returns `` shortId: `${SHORT_ID_PREFIX}${...}` ``, e.g.
`"t12"`), so the replacement wraps `shortId` verbatim - it does **not** prepend
another `t`. The emitted token is `` `t12` ``, never `` `tt12` ``.

Applied at the single existing call site in `index.ts` (currently line 389-390),
between allocation and footer append. `toolNames` come from the same `batch`,
keeping the two arrays aligned:

```ts
const summaryRefs = indexer.allocateSummaryRefs(batch);
const toolNames = batch.toolCalls.map((tc) => tc.toolName);
const decorated = substituteInlineRefs(result.summaryText, summaryRefs, toolNames);
const summaryText = decorated + formatSummaryToolCallRefs(summaryRefs);
```

`decorated` is the body with inline refs; `summaryText` is `decorated` plus the
unchanged footer. `shouldSkipOversized = summaryText.length > batchRawCharCount`
is computed on `summaryText`; substituting `[[9:read]]` -> `` `t12` `` is roughly
length-neutral and does not meaningfully move the oversize guard.

## Marker choice and substitution rules (load-bearing)

The marker is `[[N:name]]` (double square bracket, `N` = decimal digits, `name`
= the tool name), matched **only as the first non-whitespace token of a line and
outside fenced code blocks**, via:

```
/^(\s*(?:[-*]\s+)?)\[\[(\d+):([^\]\n]+)\]\]\s*/gm
```

(capture 3 = echoed tool name, validated against `toolNames[N-1]`). The name
capture is `[^\]\n]+` (any run of non-`]`, non-newline chars, stopping before
the closing `]]`) rather than a restricted `[A-Za-z0-9_-]` class **so the
degradation contract holds for every tool name**: a namespaced/dotted tool
(`server.tool`, `a:b`) still produces a *matching* label that is then validated
and, on mismatch or out-of-range, stripped. A narrower class would fail to match
such a label at all - leaving raw `[[N:name]]` in the body (fail-open), which
contradicts "any malformed/mismatched label degrades to footer-only". Trailing
whitespace after `]]` is consumed with `\s*` (not `\s?`) so the substitution
normalizes to exactly one separating space regardless of how many spaces the
model emitted.

processed line-by-line while tracking a fenced-code toggle (a line whose trimmed
form starts with ```` ``` ```` flips "inside fence"; lines inside a fence are
never substituted). Guards protecting the verbatim content the prompt is
explicitly told to copy (`argv[1]`, `items[0]`, file paths, error strings, quoted
tool output):

1. **Double brackets** are rare in copied code/prose/errors; single `[1]` (the
   common array-index shape) never matches. Obsidian-style `[[Page]]` wikilinks
   are non-numeric and never match `\d+`.
2. **Line-start anchor** (`^` with the `m` flag, allowing leading whitespace and
   an optional `-`/`*` bullet marker) means a mid-line `[[x]]`-lookalike is left
   untouched.
3. **Fenced-code exclusion** shields the realistic false-positive vector: a
   verbatim-copied log or serialized block whose line happens to start with
   `[[<digits>]]`.

Substitution semantics, per matched label with captured number `N` and echoed
name (capture 1 = leading whitespace + optional bullet prefix; capture 2 =
digits; capture 3 = echoed tool name). The name check runs first:

| Case | Action |
|---|---|
| `1 <= N <= refs.length` **and** echoed name == `toolNames[N-1]` (trimmed, case-insensitive) | Replace the whole match with `` $1`SHORTID` `` - the captured prefix, then the backtick-wrapped `refs[N-1].shortId`, then one space separator (so `- [[1:read]] Read` becomes ``- `t1` Read``, never ``- `t1`Read``). `shortId` is emitted as-is (no extra `t`) |
| `1 <= N <= refs.length` **but** echoed name != `toolNames[N-1]` | **Mismatch -> strip** the whole label (prefix re-emitted, no ref); the model desynced, so footer-only is the safe outcome instead of a confident wrong ref |
| `N` out of range (`< 1` or `> refs.length`) | Strip the label, re-emitting the captured prefix only (no dangling token); footer still covers that tool |
| `N` unparseable | Cannot occur - regex captures `\d+` only; non-numeric never matches and is left verbatim |
| Label absent on a line | No-op for that block; it renders ref-less, footer covers it |
| Same `[[N:name]]` on multiple lines of one tool | Each occurrence validated + substituted to the same `` `tN` `` (harmless, mildly helpful) |
| Label wrapped/formatted or non-standard bullet (`**[[1:read]]**`, `` `[[1:read]]` ``, `1. [[1:read]]`, `> [[1:read]]`) | The anchored substitution does not match, so no inline ref is produced. A second **catch-all strip** pass (below) then removes the raw `[[N:name]]` token from the line, leaving footer-only recovery with **no internal syntax leaked** into context. |

**Catch-all strip (leak guard).** After the anchored substitution, every
non-fenced line is swept once more with `/\[\[\d+:[^\]\n]+\]\]\s*/g` and any
surviving well-formed label token is deleted. This guarantees the invariant
*"the feature never injects a raw `[[N:name]]` token into LLM context"* even when
the model ignores the prompt and wraps/renumbers its label (the anchored pass
recovers the ref for compliant `-`/`*` bullets; the strip pass discards an
unrecoverable label rather than leaking it). It runs inside the same fence-aware
line loop, so labels inside fenced code blocks are still never touched. It
cannot hit mid-line lookalikes (`argv[1]` is a single bracket; `[[Page]]`
wikilinks have no `:digits`).

The footer from `formatSummaryToolCallRefs` is appended unchanged in every case,
so recovery is never worse than today.

### Why the name tag (mis-copy mitigation)

The number->shortId map is deterministic, but the number->bullet association is
the model's; a bare number could be copied onto the wrong bullet (typically the
model renumbering after skipping a tool) and substitute a *confidently wrong*
`` `tX` ``. Echoing the tool name in the label and validating it against the
known tool at position `N` converts that failure into a **detected mismatch that
degrades to footer-only**. This catches the dominant desync - a skip-induced
renumber lands `[[2:read]]` where position 2 is a `bash`, mismatch, strip. It is
not the earlier-rejected *prose* cross-check (parsing the bullet's free text for
a tool name, which is unreliable); it validates the model's own echoed tag, a
machine-exact token.

### Residual risk (accepted)

- **Same-type swap.** Two calls of the *same* tool (two `read`s) with their
  labels swapped both pass the name check, so a swapped `` `tX` `` still points
  at a same-kind call (wrong file). Rarer than cross-type renumber and
  lower-harm; catching it would need a content discriminator in the label
  (`[[1:read:a.ts]]`), forcing the model to copy a path verbatim - more
  error-prone and heavier, so out of scope. Footer still lists every ref.
- **Non-fenced line-start lookalike.** A verbatim-copied non-fenced line that
  begins with `[[<digits>:<word>]]` can be mis-handled (substituted if it
  happens to name-match, else stripped). Judged vanishingly rare given the
  double-bracket + `N:name` shape + line-start + fenced guards; accepted rather
  than parsing summary prose further.
- **Non-fenced mid-line label.** The catch-all strip also removes a well-formed
  `[[<digits>:<name>]]` token appearing mid-line in non-fenced prose (not just
  at line start). This is the intended leak-guard behavior; a verbatim-copied
  prose sentence that contains that exact token shape mid-line is vanishingly
  rare and accepted.
- **No flush-path integration test.** The `index.ts` flush pipeline
  (`allocateSummaryRefs` -> `substituteInlineRefs` -> footer) has no isolated
  unit harness, so the positional alignment between `refs` and `toolNames` is
  covered by the pure-function + composition unit tests, not an end-to-end
  stubbed-summarizer test. Accepted: building a `flushPending` harness is
  disproportionate to a five-line wiring change whose invariant is verified by
  reading `allocateSummaryRefs` (both arrays map the same `batch.toolCalls`).

## Range-summary propagation (inherited, not implemented)

`RANGE_SYSTEM_PROMPT` (`src/summarizer.ts`) already instructs: "Keep any
reference tokens like `` `t12` `` or `` `b3` `` intact." Chain range fusion
(`summarizeRange`) consumes the **stored** per-batch summary text, which by then
already has inline `` `tX` `` refs substituted in. So inline refs **propagate
when present in the per-batch input** with no additional code - subject to the
same LLM-compliance caveat as any ref token in the range prompt (the fusion
model is instructed to keep them but is not forced to). No production change in
the range path; covered by a confirming test asserting the fusion *input* text
carries the inline ref (the fusion *output* is mocked in existing tests, so
asserting against it would be circular).

## Testing approach

Tests follow the repo convention (`src/*.test.ts`, run by `bun test src/`). Two
new files, since neither exists today:

New file `src/summary-refs.test.ts` - `substituteInlineRefs(text, refs, toolNames)`:

- in-range + name-match replaces `[[1:read]]`/`[[2:bash]]` with the right
  shortIds (asserting the exact `` `t1` `` token, no `tt1`);
- **name mismatch** (`[[2:read]]` where `toolNames[1] === "bash"`) stripped, no
  ref emitted (the core mis-copy-mitigation case);
- name-match is trimmed + case-insensitive (`[[1:Read]]` vs `read` -> match);
- out-of-range `[[9:read]]` (only 2 refs) stripped, leaving the bullet prefix
  and no dangling token;
- absent label -> text unchanged;
- duplicate `[[2:bash]]` on two lines both substituted;
- separator preserved: `- [[1:read]] Read` -> ``- `t1` Read`` (single space,
  not glued);
- left untouched: mid-line `argv[1]`, a mid-line `[[1:read]]`-lookalike, a
  line-start `[[1:read]]` **inside a fenced code block**, and a wrapped
  `**[[1:read]]**`.

New file `src/batch-capture.test.ts` - `serializeBatchForSummarizer`:

- emits `[[1:name]]..[[N:name]]` (correct position and tool name) immediately
  before each `Tool:` in tool order;
- numbering stays 1..N over a dedup-filtered batch (fewer tool calls, still
  contiguous from 1);
- numbering stays 1..N over an agent-message-merged batch (concatenated
  `toolCalls` via `groupBatchesByMode`).

Composition (unit, in `src/summary-refs.test.ts`) - no `index.ts`/`flushPending`
integration harness exists, so the no-drift check is a pure composition of the
two helpers over one `SummaryToolCallRef[]`:

- `substituteInlineRefs(body, refs, toolNames)` inline refs and
  `formatSummaryToolCallRefs(refs)` footer refs reference the same shortIds for
  the same positions.
- A per-batch body carrying an inline `` `tX` `` still contains that token after
  passing through the range-fusion **input** assembly (asserted on the input, per
  the range-propagation note).

## Documentation impact

- Feature / user-facing docs introduced: none (behavioral refinement of an
  existing output; no new command, setting, or surface).
- Materially amended existing docs:
  - `PRUNING.md` - the "How the Model Re-reads Raw Outputs" section (line ~284)
    and the recovery ASCII ("RECOVERING PRUNED DATA", line ~209) gain a short
    note that per-tool bullets now carry an inline `` `tX` `` ref (footer
    retained as always-correct fallback).
  - `README.md` - the `context_tree_query` paragraph (line 195) currently
    describes only the footer ("Pruned summaries end with short refs like
    `Summarized tool refs: ...`"); amended in the same commit to add that each
    per-tool bullet also carries its own inline ref. (Checked now: this is the
    only summary-format description in `README.md`; no code-block sample to
    update.)
- Derived / memory docs invalidated: none (no router, AGENTS.md section, or
  index changes; the `context-prune-summary` customType row in `AGENTS.md`
  still accurately describes what the entry is).

## Acceptance criteria (from issue #2)

1. A multi-tool prune summary shows, per tool block, either an inline ref or a
   stable positional number->ref mapping. **Met** by inline `` `tX` ``
   substitution.
2. The flat footer ref list is preserved. **Met** - `formatSummaryToolCallRefs`
   output is appended unchanged.
3. No new tool, config knob, or index is added. **Met** - three edits to
   existing functions plus one new pure helper; no config, no tool, no index.
4. Degrades safely when the LLM omits/garbles a label. **Met** - name-mismatch
   and out-of-range stripped, absent label -> footer-only, mid-line lookalikes
   untouched. The name-tag validation additionally downgrades a *confidently
   wrong* in-range ref (the dominant desync) to footer-only.
