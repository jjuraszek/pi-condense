# Oversized tool-result spill + budget-delta flush

Date: 2026-06-02
Branch/worktree: `oversized-output-spill`
Status: spec (pre-implementation)

## Problem

A single large tool result can dominate the context window before any
existing pruning mechanism reacts. Observed: a session at ~70% of a 1M-token
window where one `fetch` result was ~1.08 MB (~270K tokens, ~27% of the
window) on its own.

Why nothing "kicked in":

1. **No single-result cap.** Every captured result — regardless of size —
   waits for normal batch close → async summarization → rolling-window aging
   before its raw body leaves context. A 1 MB output sits at full size for
   several turns.
2. **Budget trigger is a single aggregate gate.** `shouldBudgetFlush`
   (`src/budget.ts`) fires only when `usage.tokens / usage.contextWindow >=
   autoBudgetThreshold`, evaluated once per `turn_end`
   (`index.ts:714-730`). The user's `autoBudgetThreshold` was `0.8`
   (`DEFAULT_CONFIG` ships `null` = off); at 70% it had not yet tripped, and a
   single turn can jump from below to over-limit between two boundaries.

This spec adds two layers:

- **A — eager spill:** synchronously offload any single oversized result to a
  file and index it immediately, so it never reaches a request at full size.
- **B — budget-delta flush:** force a flush when one turn adds a large
  fraction of the window, independent of the absolute aggregate threshold.

Both reuse existing machinery (`Indexer.addBatch` → `isSummarized` →
`pruneMessages` stub-replace; `shouldBudgetFlush` + `turn_end` flush).

## Ground truth (package namespace)

This extension currently pins and imports **`@mariozechner/*`**
(`pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`) — that is what is
installed and what every source file imports, so API verification for this
spec resolves under `node_modules/@mariozechner/pi-coding-agent/dist`.

**Caveat:** the entire `@mariozechner/*` family is **deprecated**; each
package's npm metadata says "please use `@earendil-works/<pkg>` instead going
forward" (the global pi harness already runs `@earendil-works/pi-coding-agent`).
`@earendil-works/*` is the renamed continuation — same symbols, same paths —
so the table below is expected to hold verbatim after migration. Migrating
this repo's peer deps from `@mariozechner` to `@earendil-works` is a
repo-wide dependency rename, **out of scope for this spec** and tracked
separately; this feature builds against whatever the peer deps resolve to at
implementation time.

Symbols this spec depends on, verified present (in the installed
`@mariozechner` types):

| symbol | location | note |
|---|---|---|
| `getSessionDir()`, `getSessionId()`, `getSessionFile()` | `core/session-manager.d.ts:189-191` (on `ReadonlySessionManager`, l.136) | spill dir + id |
| `getContextUsage(): ContextUsage \| undefined` | `core/extensions/types.d.ts:231` | budget triggers |
| `ContextUsage.tokens: number \| null`, `contextWindow: number`, `percent: number \| null` | `core/extensions/types.d.ts:192-198` | **`tokens` is null right after compaction** — must guard |
| `truncateHead(content, options?)`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES` | `core/tools/truncate.d.ts` (re-exported from index) | options object, not positional |

## Non-goals

- Changing the `fetch` / `bash` tools (harness-owned, separate repo). A is
  tool-agnostic and covers them all.
- Orphan-blob garbage collection / startup sweep. Out of scope for v1; blob
  cleanup rides on session deletion only (see Cleanup).
- Replacing the LLM summarizer. Eager-spilled results are NOT summarized by an
  LLM; the stub is mechanical.

## A — Eager single-result spill

### Trigger

At tool-result capture (live `turn_end` path in `src/batch-capture.ts`, and
the reconstruction path `captureUnindexedBatchesFromSession`), evaluate each
`CapturedToolCall` independently. A call is **oversized** when
`resultText.length >= spillThreshold` (chars — matches `resultText.length`,
not bytes).

Ordering relative to existing pre-flush passes (precedence is strict):

1. **Protected-tools filter first** — a `protectedTools` result is never
   spilled.
2. **Dedup check second** — compute the content hash on the full in-memory
   body. If it matches an existing original, alias as today (`registerDuplicate`)
   and **do not** write a file. A duplicate of an already-spilled original
   aliases to that original's record (and thus its `spillPath`); the byte cost
   is paid once.
3. **Spill last** — only a non-duplicate oversized result is written to a
   sidecar file and indexed.

The spill + `addBatch` happens before the existing `flushPending` call in the
`turn_end` handler. No extra `context` event is forced; the stub takes effect
on the next natural `context` build (same as today's summarized records).

### Storage (hybrid)

- Bodies `< spillThreshold` stay **inline** in the `context-prune-index`
  entry exactly as today (`IndexEntryData.toolCalls[].resultText`). Portable:
  the JSONL remains self-contained for all normal content.
- Bodies `>= spillThreshold` are written to a **sidecar file**; the index
  entry stores a reference + head preview instead of the full body.

File location:

```
<sessionDir>/<sessionId>-blobs/<toolCallId>.txt
```

- `sessionDir = ctx.sessionManager.getSessionDir()`, `sessionId =
  ctx.sessionManager.getSessionId()` (confirmed on `ReadonlySessionManager`,
  `session-manager.d.ts`). Persistent root alongside the session JSONL —
  survives reboot/resume, not subject to `os.tmpdir()` reapers.
- One file per tool call, full verbatim `resultText`, UTF-8.
- `toolCallId` is filename-safe in practice (provider ids like
  `toolu_...`); sanitize defensively (`[^A-Za-z0-9_-]` → `_`) to avoid path
  traversal / separators.

### Record / persistence changes

`ToolCallRecord` (`src/types.ts`) gains optional fields:

```ts
spillPath?: string;      // absolute path to the sidecar blob
spillBytes?: number;     // full byte length of the spilled body
resultPreview?: string;  // head preview kept inline when spilled
contentHash?: string;    // dedup hash of the FULL body, persisted
```

**`resultText` invariant.** Persisting the full body in the index entry would
defeat the spill (MB back in the JSONL). So for a spilled record the persisted
entry carries `resultPreview` (not the full body), `spillPath`, `spillBytes`,
and `contentHash`. The full `resultText` exists only transiently in memory at
capture time — long enough to compute `contentHash` and write the file — and
is not serialized.

**Dedup hash persistence.** Today `addBatch` computes the content hash from
`resultText` and `reconstructFromSession` recomputes it on reload. A spilled
record has no full `resultText` after reload, so the hash is computed once at
spill time and **persisted** as `contentHash`; reconstruct reads it back
instead of recomputing. Non-spilled records keep the existing
recompute-from-`resultText` path unchanged.

**No summarizer path.** Eager-spilled records bypass
`serializeBatchForSummarizer` entirely (they are never sent to the LLM
summarizer), so there is no double-truncation between preview and summarizer
input.

`IndexEntryData.toolCalls[]` already serializes `ToolCallRecord`, so adding the
optional fields persists them with no new custom entry type.
`Indexer.reconstructFromSession` replays them unchanged; the preview + hash
travel inline, the full body stays on disk.

### What the model sees (stub)

`pruneMessages` already stub-replaces any `isSummarized` tool result. For a
spilled record the stub text is **mechanical** (no LLM summary) and contains:

- tool name + a compact rendering of args,
- size (`spillBytes` and line count),
- the head preview (`resultText`),
- the absolute `spillPath` and an explicit hint:
  `read this file (offset/limit supported) to access the full output`,
- the existing short-ref line so `context_tree_query` still works.

This gives file-handle ergonomics: the model slices the body on demand with
the native `read` tool; no LLM round-trip happened on capture.

### Stub branching (`src/pruner.ts`)

`pruneMessages` Phase 1 already replaces a summarized tool result with a single
hardcoded `[Summarized … ref tN]` stub. It must branch on the resolved record:

- `getRecord(toolCallId)` has `spillPath` set → emit the **mechanical spill
  stub**: tool name, compact args, `spillBytes` + line count, the
  `resultPreview`, the absolute `spillPath`, a `read this file (offset/limit
  supported)` hint, and the existing short-ref line.
- otherwise → emit the **existing summary-ref stub** unchanged.

Both branches return a stub message (never delete the result) so pi-ai's
orthan-tool-result repair is not triggered.

### Indexing (synchronous, no summarizer)

Eager spill must make the result `isSummarized` immediately so `pruneMessages`
stubs it on the very next `context` build, without waiting for `flushPending`
or an LLM call. Reuse `Indexer.addBatch` with a single-call batch carrying the
spilled record(s); it issues short refs, persists the index entry via
`appendEntry`, and updates the in-memory map. No `context-prune-summary`
message is emitted for eager-spilled results (the stub is self-describing).

### Recovery

`context_tree_query` (`src/query-tool.ts`): when the resolved record has
`spillPath`, read the file and apply the **existing**
`truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines:
DEFAULT_MAX_LINES })` call already used in this file to the file contents
instead of to `resultText` — no new constants or exports. Falls back to
`resultPreview` if the file is missing. The primary recovery path the model
should use is the native `read` tool on `spillPath` (full slicing);
`context_tree_query` remains the head-truncated fallback.

### Failure handling

- **Write-then-mutate (atomic).** Write the sidecar file first; mutate the
  record fields (`spillPath`/`spillBytes`/`resultPreview`/`contentHash`) only
  after `writeFile` resolves. A throw leaves the `CapturedToolCall` untouched
  and the result falls through to the normal flush pipeline. Never drop a
  result. Log at debug.
- **Filename collision.** `toolCallId` is unique per call and the sanitized
  alphabet (`[^A-Za-z0-9_-]` → `_`) collides only on pathological ids; before
  writing, if the target path already exists for a different record, fall back
  to inline rather than overwrite.
- Missing blob at query time → return `resultPreview` + a note that the full
  body is unavailable.

## B — Budget-delta flush

Add a second, delta-based flush trigger in the `turn_end` handler, evaluated
alongside the existing absolute `shouldBudgetFlush`.

- New config `budgetTurnDelta: number | null` (fraction of window, default
  `null` = off; suggested operational value `0.15`).
- Track the previous turn's usage fraction (`tokens / contextWindow`) as a
  module-level variable in `index.ts`, set to `null` on `session_start`.
  After a restart the first turn cannot fire the delta trigger (no previous
  fraction); this gap is accepted because the absolute `autoBudgetThreshold`
  still guards the post-restart aggregate. On a turn where `usage.tokens` is
  null (e.g. immediately after compaction), leave `previousFraction`
  unchanged rather than overwriting it, so the next real reading is compared
  against the last known fraction.
- If `(currentFraction - previousFraction) >= budgetTurnDelta`, call
  `flushPending(ctx, { delivery: "session" })` — same flush the aggregate
  trigger uses.
- Either trigger (absolute OR delta) firing causes a flush; they are ORed.

Rationale: catches a turn that adds a large aggregate (many medium outputs, or
a spike that A's per-result threshold didn't individually catch) without
waiting to cross the absolute `autoBudgetThreshold`.

Helper lives in `src/budget.ts` next to `shouldBudgetFlush`:

```ts
export function shouldDeltaFlush(
  usage: ContextUsage | undefined,
  previousFraction: number | null,
  delta: number | null,
): boolean
```

Pure; mirrors `shouldBudgetFlush`'s guards exactly — returns `false` when
`!usage || usage.tokens == null || !(usage.contextWindow > 0) || delta == null
|| previousFraction == null`. Uses the same 0–1 `tokens / contextWindow`
fraction (not `ContextUsage.percent`, which is 0–100 and null when `tokens`
is). Because `tokens` is null right after a compaction, `previousFraction` is
left unchanged on a null-token turn (no spurious delta when usage
"reappears").

## Config (`DEFAULT_CONFIG`, `src/types.ts`)

| field | type | default | meaning |
|---|---|---|---|
| `spillThreshold` | `number` | `65536` | min chars (`resultText.length`) for a single result to spill |
| `spillPreviewBytes` | `number` | `2048` | head-preview size in **bytes** kept inline as `resultPreview` |
| `budgetTurnDelta` | `number \| null` | `null` | per-turn usage-fraction increase that forces a flush |

`spillThreshold` is intentionally high (64 KB): only genuinely huge outputs
spill; medium outputs (tens of KB) keep flowing through normal
summarization/dedup so the model sees them without a `read` round-trip.

## Cleanup

- The blob dir is a sibling of the session file; deleting the session dir
  removes its blobs. No separate GC in v1.
- No orphan sweep on startup (explicit non-goal). Accepted: blobs for deleted
  sessions whose dir was partially removed can linger; revisit if it matters.

## Touched files

| file | change |
|---|---|
| `src/types.ts` | `ToolCallRecord.spillPath?/spillBytes?`; `DEFAULT_CONFIG` + `ContextPruneConfig` gain `spillThreshold`, `spillPreviewBytes`, `budgetTurnDelta` |
| `src/spill.ts` (new) | pure-ish helpers: `blobDirFor`, `blobPathFor`, `headPreview`, `writeSpill`, `readSpill`; isolates fs + path sanitize |
| `src/batch-capture.ts` | protected filter → dedup → spill non-duplicate oversized `CapturedToolCall`s (write file, set `spillPath`/`spillBytes`/`resultPreview`/`contentHash`), `addBatch` synchronously |
| `src/indexer.ts` | persist + replay `contentHash` for spilled records (skip recompute when present); pass new optional fields through `reconstructFromSession` |
| `src/pruner.ts` | branch on `spillPath`: mechanical spill stub vs. existing summary-ref stub |
| `src/query-tool.ts` | `spillPath` → read file then `truncateHead`; fallback to preview |
| `src/budget.ts` | `shouldDeltaFlush` |
| `index.ts` | `turn_end`: track previous usage fraction; OR `shouldDeltaFlush` into the flush decision; reset on `session_start` |
| `README.md` | document the 3 new settings + `read`-the-blob recovery |
| `PRUNING.md` | document eager-spill layer + budget-delta trigger |

## Testing

Pure unit:
- threshold gating (`< / == / >` `spillThreshold`).
- `headPreview` (line-boundary cut, byte cap, multibyte safety).
- blob path sanitize (no traversal/separators).
- `shouldDeltaFlush` truth table (null delta, missing usage, below/at/above).

Integration (Pi extension smoke, per AGENTS.md):
- oversized result → sidecar file exists with full body; index entry has
  `spillPath` + preview, not full body.
- `pruneMessages` stubs the spilled result on the next `context` build with
  **no** `context-prune-summary` and **no** summarizer LLM call.
- `context_tree_query` on the spilled id returns file-backed (head-truncated)
  content; `read` on `spillPath` returns the full body.
- spill + dedup: a large result spills once; an identical later result aliases
  to the spilled original (no second file write) and resolves to the same
  `spillPath`.
- reconstruct-from-session: after restart, record still resolves, blob still
  read.
- budget-delta: a turn whose usage jump `>= budgetTurnDelta` triggers
  `flushPending`; below it does not; a null-`tokens` turn neither fires nor
  overwrites `previousFraction`.

Typecheck before commit per AGENTS.md (`bun x tsc --noEmit ...`).

## Open questions

None. Threshold (64 KB), B in scope, no orphan sweep — all decided.
