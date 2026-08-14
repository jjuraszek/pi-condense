# Uncovered-chain deterministic compression with recoverability backfill

Fixes [jjuraszek/pi-condense#10](https://github.com/jjuraszek/pi-condense/issues/10).

## Problem

`compressEligible` (`src/chain-compressor.ts:118-126`) permanently skips eligible
chains with zero per-batch summary coverage (`reason: "no-summary"`). The skip is
structural: once the prune frontier passes a span without a summary body (trivial
batch, `skipped-oversized`, fully-deduped batch, or a capture miss),
`trimBatchToPendingRange` excludes it from future capture forever. No amount of
waiting, `/pruner now`, or `/pruner compact` recovers it.

Motivating incident (session `2026-08-12T10-47-56`): a 639-call chain, ~935k chars
(~300k tokens, ~62% of a 620k context window) stranded live, repeatedly skipped
with `no-summary`.

Zero coverage is a normal-path occurrence, not exotic - the fix must be harmless
when triggered: deterministic, zero LLM calls, fail-closed.

## Decisions (user-ratified)

| # | Decision |
|---|---|
| D1 | Body contract: reuse `rangeSummaryText` for the deterministic stub text + optional `bodySource: "deterministic"` discriminant on the chain entry. Zero renderer change; entries without `bodySource` keep current semantics. |
| D2 | Anti-regression cage: deterministic unit tests only, exhaustive over the ACs. No automated e2e harness (repo convention: `bun test src/`; e2e smoke stays manual per AGENTS.md). |
| D3 | Architecture: compressor-owned backfill. Branch messages threaded into `compressEligible` deps; new indexer method `backfillChainRecords` persists the index entry and issues refs, skipping dedup-canonical registration. Covered path untouched. |
| D4 | Design rule (now in AGENTS.core.md, all four repos): no new machinery if not essential. Every addition below reuses an existing field, type, or path plus a small discriminant. |
| D5 | Adjudicated at review, not pre-planned (see "Implementation deviations" below): fully-protected zero-coverage chains skip silently (no `backfill-empty`); `extractChainRecords` takes `isIndexed` only, protection is read from `chain.protectedToolCallIds`; `buildDeterministicBody` drops the unused `chain` param; `backfillChainRecords` takes an `opts` object (spill config + session identity + `appendEntry`), not a bare callback; `resolveRange`'s entry param widens to a `Pick<...>` type (no behavior change). |

## Architecture

`compressEligible` gains a second branch at the current `no-summary` skip.
`CompressEligibleDeps` grows: `messages: any[]` (**the same array chain
detection ran on**, i.e. the `withClosingMessage(...)` output - threading raw
`branchMessages` would lose the closing assistant on the message_end path with
`rollingWindow: 0` and spuriously fail span resolution), `diagnostics:
Pick<DiagnosticSink, "report">`, and `backfill: { spillThreshold;
spillPreviewBytes; sessionDir; sessionId }` (the spill seam). Both call sites
(`flushPending` at `index.ts:658-671` and `/pruner compact` at
`index.ts:1035-1043`) already hold all of these.

For an eligible zero-coverage chain:

1. **Resolve + extract** - resolve the chain's positional span with the existing
   `resolveRange` (`src/chain-range-prune.ts`) - same fail-closed duplicate-
   timestamp semantics as the drop path. As shipped, `resolveRange`'s entry
   param widens to `Pick<ChainCompressionEntry, "startUserTimestamp" |
   "finalAssistantTimestamp">` so `extractChainRecords` can call it with a
   `ChainRange` instead of a persisted chain entry - type-level only, behavior
   identical, regression-tested (see "Unchanged" below for scope). Walk the
   resolved span; for each middle tool call **not protected** (read from
   `chain.protectedToolCallIds`, the same in-chain data `detectChains` already
   populated - protected outputs are relocated verbatim at render time and must
   never be phase-1 stubbed, so they are never backfilled) and **not already
   indexed** (predicate: index membership, i.e. the indexer's private `index` map
   has the occurrence key - NOT `isSummarized()`, which also covers dedup aliases
   and would strand the fully-deduped sub-case named in Problem), build a
   `ToolCallRecord`:
   - `toolCallId`, `toolName`, `args`, `isError` from the messages;
   - `resultText` = full result text; `timestamp` = the toolResult message
     timestamp; `resultTimestamp` likewise (occurrence-key discriminant, via
     existing `occurrence-key.ts` helpers);
   - `turnIndex` = `-1` sentinel (backfilled records have no batch turn;
     `context_tree_query` renders `Turn: -1` - accepted cosmetic).
   Dedup-aliased members are re-indexed verbatim; their existing alias entries
   keep resolving unchanged. Extraction is a pure walk returning full-text
   records; spilling happens in step 2.
2. **Backfill (fail-closed, append-before-commit)** -
   `indexer.backfillChainRecords(records, opts)` (async), where `opts = {
   spillThreshold, spillPreviewBytes, sessionDir, sessionId, appendEntry }`:
   - spill oversized results via the shared spill helpers (`blobPathFor`/
     `applySpill`), a fail-closed variant of the eager `spillOversizedBatch`
     path (record gets `spillPath`/`spillBytes`/`resultPreview`/`contentHash`,
     `resultText` emptied) - a ~935k-char member must not be inlined into the
     session JSONL;
   - allocate `t<N>` refs via the existing `allocateSummaryRefs` /
     `buildShortToolCallRefs` (monotonic `nextShortAliasNumber`);
   - persist **one** `context-prune-index` entry carrying the records, the
     allocated `SummaryToolCallRef[]`, and `backfilled: true` - refs ride the
     index entry so they are durable the moment the records are (atomic);
   - **only after the append succeeds**, commit in-memory state: records into
     the `index` map, aliases via `registerSummaryRefs`. A failed append leaves
     records and alias maps unchanged (burned alias numbers are acceptable -
     `t<N>` is opaque and monotonic, gaps are harmless);
   - never touch `contentHashToOriginal`.
   Any throw -> keep the existing `no-summary` skip; retried next flush.
3. **Compose** - `buildDeterministicBody(records, refs)`: call count,
   tool-name histogram, span duration, first/last call name + args excerpt capped
   at 200 chars, and the refs. Zero LLM calls. On a retry where some/all members
   are already indexed (prior partial failure), refs for indexed members are
   recovered via the existing `getToolRefsForToolCallIds` and the records via the
   index - the body is composed over the full chain, not just newly extracted
   records.
4. **Persist** - chain entry as today, plus `rangeSummaryText` (the deterministic
   body) and `bodySource: "deterministic"`.

**Retry discriminator** (partial-failure convergence): zero extractable records
AND zero chain members present in the index -> genuine span mismatch ->
fail-closed skip + `backfill-empty` diagnostic. Zero newly extracted records but
members ARE in the index (prior index append succeeded, chain append failed) ->
proceed to compose + persist the chain entry using the already-durable records
and refs. The same observable "nothing new to extract" state never routes to a
permanent skip when recovery data exists.

**Fully-protected exception to the discriminator** (D5, adjudicated at review):
if the zero-extractable/zero-indexed state above is instead explained by every
middle call being protected (`chain.middleToolCallIds` non-empty and all present
in `chain.protectedToolCallIds`), the chain still takes the plain `no-summary`
skip but **without** the `backfill-empty` diagnostic. Compressing such a chain
saves zero tokens - every output would be relocated verbatim into the synthetic
body at render time regardless - and reporting `backfill-empty` for it would
misreport a healthy, fully-protected span as a mismatch, re-firing on every
restart for protected-heavy configs. This guard runs first; `backfill-empty`
only fires for the remaining genuine-mismatch case.

Covered chains take the existing branch untouched - byte-identical by construction.

## Components

### `src/chain-compressor.ts`

- `CompressEligibleDeps` gains `messages`, `diagnostics`, and the spill seam
  (see Architecture).
- New pure helper `extractChainRecords(messages, chain, isIndexed):
  ToolCallRecord[]` - `resolveRange`-based span walk; no separate protection
  predicate param, protection is read from `chain.protectedToolCallIds`
  (in-chain data already populated by `detectChains`).
- New pure helper `buildDeterministicBody(records, refs): string` - no `chain`
  param (unused by the body grammar).
- `CompressEligibleResult` unchanged (no new counters - cut as non-essential per
  D4; `bodySource` on the persisted entries already distinguishes deterministic
  compressions for offline inspection).

### `src/indexer.ts`

- `backfillChainRecords(records, opts): Promise<SummaryToolCallRef[]>` where
  `opts = { spillThreshold, spillPreviewBytes, sessionDir, sessionId,
  appendEntry }` - async; spill, allocate refs, append the marked index entry,
  then commit maps (order per Architecture step 2). `ToolCallIndexer` owns no
  appender today, so the callback rides the options object alongside the spill
  config and session identity it also needs (mirrors what the `turn_end`
  eager-spill path already assembles for `spillOversizedBatch`, `index.ts:900`).
- `reconstructFromSession`: index entries with `backfilled: true` -> records
  restored into the `index` map, refs re-registered via `registerSummaryRefs`,
  dedup-canonical registration (`contentHashToOriginal`) skipped. Rationale:
  alias reconstruction today happens only from `CUSTOM_TYPE_SUMMARY` entries
  (`src/indexer.ts:95-97`); backfilled chains have no summary message, so the
  backfilled index entry is the durable ref carrier.

### `src/types.ts`

- `ChainCompressionEntry` gains `bodySource?: "deterministic"`.
- Index entry data gains `backfilled?: true` and optional
  `refs?: SummaryToolCallRef[]` (present only on backfilled entries).
- `DiagnosticKind` union gains `"backfill-empty"` (closed 3-member union today,
  `src/types.ts:97`).
- All optional -> pre-existing entries load unchanged.

### `src/diagnostics.ts` / `src/commands.ts`

- `DiagnosticSink.counters` literal gains the new kind.
- `pruneStatusText` (`src/commands.ts:70-77`) hardcodes the three existing kinds;
  gains `backfill-empty` (widget suffix, e.g. `diag ... b<N>`).
- `/pruner compact` report text unchanged (deterministic-vs-fused distinction cut
  as non-essential; the persisted `bodySource` field carries that information).

### `index.ts`

- Threads `messages` (the `withClosingMessage` array), `diagnostics`, and the
  spill seam into both `compressEligible` call sites.
- `context-prune-flush-metrics`: unchanged (new counter cut as non-essential).

### `src/chain-range-prune.ts`

- `resolveRange`'s entry param widens from `ChainCompressionEntry` to
  `Pick<ChainCompressionEntry, "startUserTimestamp" | "finalAssistantTimestamp">`
  so `extractChainRecords` (which walks a `ChainRange`, not a persisted entry)
  can call it directly. Type-level only; behavior identical, regression-tested.
  Renderer behavior otherwise unchanged: still prefers `entry.rangeSummaryText`
  (`src/pruner.ts:154`); protected-output relocation is still live-by-id,
  coverage-independent.

### Unchanged

`src/pruner.ts`, `src/summarizer.ts`, `src/block-refs.ts` (`b<N>` issuance
identical for both branches), `CompressEligibleResult`, flush-metrics entry
shape, compact report text.

## Data flow

**Live flush (automatic - no command required).** `flushPending` finishes
per-batch summarization -> `detectChains` -> `compressEligible`. Zero-coverage
chains take resolve/extract -> backfill -> compose -> persist. Ordering: index
entry (with refs) before chain entry. If the chain-entry persist fails, records
AND refs are already durable; the next flush retries and the retry discriminator
routes it to compose-from-index, converging without duplicate index entries.

**Known limitation (stated, not fixed here):** `flushPending` returns early when
there are no pending batches, before chain detection. A stranded chain in an
otherwise idle session is therefore healed on the next flush that has any work,
or immediately by `/pruner compact` - not by `/pruner now` on an empty queue.
Acceptable: the motivating incident occurred in an actively flushing session.

**Render.** Unchanged: `pruneMessages` resolves ranges positionally and prefers
`entry.rangeSummaryText`. The deterministic body renders inside the same
`<compressed-chain id="bN" tools="...">` envelope with working `t<N>` refs.

**Recovery.** `context_tree_query("tN")` -> alias map -> occurrence key ->
backfilled record (or its spill file) -> raw body. Identical to summary-issued
refs.

**Restart.** `reconstructFromSession` replays entries in order: backfilled index
entries restore records + aliases (dedup skipped), chain entries restore the
registry. Post-restart behavior is identical to pre-restart, including the
partial-failure retry (records + refs reconstruct from the index entry alone).

**`/pruner compact`.** Same `compressEligible` call - all uncovered chains handled
in one pass, no cap (no LLM cost to bound), zero summarizer traffic.

## Error handling and edge cases

- **Backfill throws** (spill I/O, append failure, malformed span) -> local catch,
  chain skipped with `reason: "no-summary"` (fail-closed). Append-before-commit
  guarantees in-memory maps are untouched on failure, so phase-1 stub-replace
  cannot fire for records whose backfill never became durable. Retried next flush.
- **Index entry persisted, chain entry persist fails** -> records + refs durable;
  retry discriminator (see Architecture) composes from the index. Converges, no
  duplicate index entries, no re-stranding.
- **Genuine span mismatch** (zero extractable records AND zero members indexed,
  and NOT explained by full protection - see next bullet) -> fail-closed skip +
  `DiagnosticSink` report, kind `backfill-empty`, deduped per chain key.
- **Fully-protected uncovered chain** (D5) -> zero extractable records and zero
  members indexed, but every middle call is in `chain.protectedToolCallIds` ->
  fail-closed skip, same as a genuine mismatch, but **no** `backfill-empty`
  diagnostic. Compressing would save zero tokens (everything is relocated
  verbatim at render regardless), and reporting a mismatch here would misreport
  a healthy span, re-firing every restart for protected-heavy configs.
- **Oversized member results** -> spilled via the shared spill helpers
  (`blobPathFor`/`applySpill`), a fail-closed variant of the eager
  `spillOversizedBatch` path; the index entry carries `spillPath`/
  `resultPreview`, never the full body.
- **Empty args/results** -> body non-empty by construction (count / histogram /
  duration always present); excerpts capped at 200 chars.
- **Protected outputs inside an uncovered chain** -> excluded from backfill
  entirely (never indexed -> never phase-1 stubbed, even in the chain-entry
  failure window); at render time `chain-range-prune.ts` relocates them verbatim
  by bare id within the resolved range, unchanged. If protection covers *every*
  middle call in the chain, the chain hits the fully-protected exception above
  instead of `backfill-empty`.
- **Dedup** - backfilled records never become `contentHashToOriginal` canonicals
  (live and reconstruction paths both honor `backfilled: true`). A later identical
  output finds no canonical and is indexed normally. Fully-deduped chains ARE
  backfilled (index-membership filter, not `isSummarized`); their pre-existing
  alias entries keep resolving.
- **`isSummarized()`** is true for backfilled occurrences once the index append
  commits: phase-1 stub-replace may fire even if the chain entry append later
  fails - acceptable, the raw content is durable and recoverable.
- **Legacy entries** (no `bodySource` / `backfilled` / `refs`) -> absence
  preserves today's semantics exactly.
- **Cache-prefix impact** - compressing a chain rewrites in-flight history from
  that point, invalidating the provider prompt-cache suffix **once**. Frequency
  is unchanged: eligibility timing is owned by the existing rolling-window logic;
  this fix only removes the terminal skip, so marginal invalidations = one per
  previously-stranded chain. The deterministic body is render-stable (no `now()`,
  no LLM nondeterminism), so post-compression renders are byte-identical and
  cache-friendly. Retry convergence cannot thrash: retries run only while the
  chain entry never persisted (nothing was rewritten yet); once it lands the
  output is frozen. Economics: a stranded ~300k-token chain costs a cache-read
  (~0.1x input price) on every call forever; the one-time suffix re-write
  (~1.25x) breaks even within ~1-2 calls. Same trade every existing prune
  (phase-1 stub replacement) already makes - no new invalidation class.

## Out of scope (follow-up tickets per the issue's roast)

- Coverage-ratio gate for `hasPerBatchSummaryCoveringAny` (any-overlap today: a
  639-call chain with 1 covered call takes the covered path).
- Capture-layer anomaly root cause (why an 800-turn agent-message cycle produced
  no batch).
- Partial-coverage handling: chains with any coverage take the existing covered
  path, unchanged.
- Chain-only compression on an empty flush (see Known limitation).

## Testing approach

Deterministic unit cage (D2), all through pure seams (`compressEligible` with
stubbed deps, indexer directly). `bun test src/` green is an AC.

New behavior (`src/chain-compressor.test.ts`, `src/indexer.test.ts`):

- zero-coverage chain -> compressed; body contains count, histogram, duration,
  refs; `fuseRange` spy never called (zero-LLM assertion)
- `backfillChainRecords`: records queryable by raw id and `t<N>` ref;
  `contentHashToOriginal` untouched; index entry carries `backfilled: true` +
  `refs`
- append failure -> in-memory index and alias maps unchanged, no chain entry,
  `no-summary` skip (fail-closed transactionality)
- chain-append-failure -> restart -> retry: records + refs reconstruct from the
  backfilled index entry; retry composes and persists the chain entry; no
  duplicate index entries (convergence test)
- retry discriminator: members-indexed state composes; zero-extracted +
  zero-indexed state skips with `backfill-empty` diagnostic
- fully-deduped chain -> backfilled (index-membership filter), compressed, alias
  entries still resolve
- protected member -> excluded from backfill records and refs; relocated verbatim
  at render
- oversized member -> spilled (`spillPath`/`resultPreview`/`contentHash` set,
  `resultText` empty, full body absent from the persisted entry)
- empty-args chain -> non-empty body; 200-char excerpt cap enforced
- backfilled record renders `Turn: -1` in `context_tree_query` output (pinned
  cosmetic)

Anti-regression cage:

- covered-path byte-identity: chain with coverage -> entry deep-equals pre-change
  snapshot; `bodySource` unset; backfill spy never invoked (the existing
  "skips chain with no summary" test at `src/chain-compressor.test.ts:129-140`
  becomes the deterministic-compression test; the covered path gets its own
  identity test)
- legacy round-trip: real pre-change `context-prune-chain` and
  `context-prune-index` JSONL fixtures reconstruct to identical state
- restart: write entries -> `reconstructFromSession` -> refs resolve, dedup
  canonicals exclude backfilled records
- integration (`src/range-compression.integration.test.ts`, existing file): one
  covered + one uncovered chain in a single flush -> both compressed, covered
  output unchanged, `expectNoOrphanToolResults` holds
- multi-chain compact: three uncovered chains, one `compressEligible` call ->
  three deterministic entries

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: PRUNING.md (deterministic-fallback subsection
  in the algorithm + rationale; diagnostics table gains `backfill-empty`),
  README.md (compact behavior note + empty-flush limitation), AGENTS.md
  (`context-prune-chain` row: `bodySource`; `context-prune-index` row:
  `backfilled` + `refs`; diagnostics row: `backfill-empty`)
- Derived / memory docs invalidated: none

## Acceptance criteria (from the issue, verbatim intent)

- [ ] Covered chains: output byte-identical to current behavior; new unit test
      asserts the deterministic path is not taken when coverage exists.
- [ ] An eligible zero-coverage chain is compressed with a deterministic body:
      call count, tool histogram, span duration, working `t<N>` refs; zero LLM
      calls asserted.
- [ ] `context_tree_query` returns the raw output for a tool call inside a
      backfilled compressed range.
- [ ] Backfill failure -> chain remains uncompressed with `no-summary` skip;
      partial failure (index persisted, chain entry not) converges on retry
      instead of re-stranding.
- [ ] Backfilled index records are excluded from content-hash dedup canonical
      lookup.
- [ ] Synthetic body renders non-empty even for a chain whose calls have empty
      args/results.
- [ ] `session_start` reconstruction round-trips the new entry fields (including
      refs on backfilled index entries); pre-existing entries without them load
      unchanged.
- [ ] `/pruner compact` handles multiple uncovered chains in one invocation.
- [ ] PRUNING.md and README updated; `bun test src/` green.
