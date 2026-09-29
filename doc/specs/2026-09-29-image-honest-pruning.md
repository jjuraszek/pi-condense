# Image-honest pruning: summaries, recovery, and reclaim size

Date: 2026-09-29

**Goal:** when a tool result carries an image, the summary states that an image was returned (not that the read was empty), `context_tree_query` gives the model the original image back, pre-flush dedup only aliases pixel-identical images, and the live reclaim figure prices an image at the same flat estimate the frontier-gap trigger uses.

Supersedes `doc/specs/2026-06-21-cost-event-reclaim-status.md`, the `sizeMessages` basis (serialized `JSON.stringify(messages).length`) in "Change 2 - live reclaim headline" / "Measurement (single point, all mechanisms)" only.
Supersedes `doc/specs/2026-08-12-single-chain-observability-trigger-repair.md`, the per-message character measure in "Measurement convention" for image blocks only (code already changed by 2.11.1, commit `b7f7175`).

## Problem

Evidence session `2026-09-29T03-13-26-393Z_01a0eb27-2579-7157-88ad-4a11c7ccd56b.jsonl`: the agent read screenshots with `read` on PNG files; pi-condense pruned the results and the model lost the images.

1. **Summary misstates the result.** `extractToolResultText` (`src/batch-capture.ts`) keeps only `type === "text"` blocks, so the summarizer receives `Read image file [image/png]` with no trace of the image. The session's summaries say: "`t3` Read `dashboard/tmp/shots/sheets/tasks.png`. It returned only "Read image file [image/png]", with no visible description of the image content." The main model did see the image; the summary tells it the read came back empty. The summarizer did not invent visual detail; `SYSTEM_PROMPT` (`src/summarizer.ts`) has no rule about images it cannot see.
2. **Recovery promise is false.** The stub and footer point at `context_tree_query`, which returns `record.resultText` as one text block (`src/query-tool.ts`) - for an image result, only `Read image file [image/png]`. The original image block still exists in the session branch; nothing reads it back.
3. **Dedup aliases different images.** Pre-flush dedup keys on `(toolName, normalize(resultText))` (`src/content-hash.ts`, `src/indexer.ts`). Every PNG `read` yields the same text, so every later image read aliases the first. The evidence session holds 4 `context-prune-dedup-alias` entries across different screenshots. Once recovery returns images, an alias would return the wrong picture.
4. **Reclaim figure is inflated.** `sizeMessages` (`src/pruner.ts`) is `JSON.stringify(messages).length`. An image counts its full base64 length before the prune and only the stub after; one 137k-char screenshot reads as ~34k tokens reclaimed. The provider bills ~1-1.6k tokens per image. `charsOf` in `src/context-metrics.ts` (2.11.1) already prices an image block at a flat `IMAGE_TOKEN_ESTIMATE = 1600` tokens (6,400 proxy chars), but is private.

Accepted premise (user, 2026-09-29): the fault is a summary that misreports the tool result plus a recovery hint that cannot deliver the image, not a summarizer inventing visual detail. A one-line prompt guard against describing visual content is included anyway.

## Acceptance criteria

none - no ticket

## Design

Three root fixes, no new persisted field, no config change. User rule: less code and less conditionality wins.

### 1. Image marker in captured text

`extractToolResultText(content)` (`src/batch-capture.ts`) emits one line per `type === "image"` block, in block order, **before** the text blocks, then the text blocks as today:

```
[image returned: <mimeType> sha256:<8hex>]
```

- `<8hex>` is the first 8 hex chars of `sha256(block.data)` (the base64 string as stored).
- Markers lead because `serializeBatchForSummarizer` keeps only the first 2,000 result chars; a trailing marker after long text would never reach the summarizer.
- Other non-text, non-image blocks stay ignored.
- Lines join with `\n`, as text blocks do today.

Every capture path calls this function - turn-end batch capture (`src/batch-capture.ts`), chain backfill (`src/chain-compressor.ts`), and protected-result text relocation (`src/chain-range-prune.ts`) - so all three see the marker with no per-path code. The marker lands in `CapturedToolCall.resultText` and `ToolCallRecord.resultText`, so:

- the summarizer sees that an image was returned;
- `context_tree_query` text records the image;
- dedup hashes the marker with the rest of the normalized text, so two image reads alias only when their base64 is identical (to the 8-hex prefix).

`SYSTEM_PROMPT` (`src/summarizer.ts`) gains one sentence: an `[image returned: ...]` line means the tool returned an image you cannot see; state that an image was returned and never describe its content.

### 2. Recovery returns original image blocks

The marker hash is the lookup key. `context_tree_query`'s `execute` (`src/query-tool.ts`) reads `ctx.sessionManager.getBranch()` once per call and indexes every image block on it: for each entry with `entry.type === "message"` and `entry.message.role === "toolResult"`, each `type === "image"` block of `entry.message.content` maps `sha256(data)` first-8-hex -> block. For each found record, it collects the `sha256:<8hex>` values from the `[image returned: ...]` markers in the record's raw text (the `resultText`, or spill sidecar / `resultPreview`, that the query already loads, before truncation) and appends the matching blocks.

- Tool output `content` becomes `[{ type: "text", text: combined }, ...images]`, images in record order then marker order. `details` is unchanged.
- The hash, not the occurrence identity, picks the image, so every record shape resolves the same way: short refs, explicit `id@timestamp` keys, and bare alias ids (whose indexer record pairs the original's `toolCallId` with the alias's `resultTimestamp`, `src/indexer.ts` `getRecordsForId`) all return the pixels the marker names.
- No marker (every pre-change record, including pre-change dedup aliases between different PNGs) or no branch match (image off the current branch) contributes no images; the text output is exactly today's. A pre-change alias therefore never returns another screenshot's pixels.
- The tool `description` gains one clause: results include the original image blocks when the pruned output carried images.
- Recovered images are ordinary tool-result content: `maxImagesPerRequest` (`src/image-cap.ts`) caps them, `charsOf` prices them at 1,600 tokens in the frontier gap, `recoveryGraceTurns` (`src/recovery-grace.ts`) reverts the query output to a stub after the grace window, and if the query result is itself captured later, section 1's marker describes its images.

### 3. Reclaim size shares the image-aware measure

- `charsOf` in `src/context-metrics.ts` is exported, behavior unchanged.
- `sizeMessages(messages)` (`src/pruner.ts`) returns the sum of `charsOf(message)` over `messages`.
- `pruneMessages`' `beforeChars` / `afterChars` and the widget's `Math.round(chars / 4)` conversion (`src/commands.ts`) stay as they are; the footer's reclaim figure now prices an image at 1,600 tokens, the same as the frontier-gap trigger.

### Data flow after the change

`read tasks.png` returns text + image -> capture writes `resultText = "[image returned: image/png sha256:3f9a2c1e]\nRead image file [image/png]"` -> summarizer writes e.g. "Read `tasks.png`; returned an image (image/png), not shown to the summarizer" -> stub points at `context_tree_query` as today -> the query returns the recorded text plus the PNG block whose hash is `3f9a2c1e`.

## Errors and edge cases

- **Legacy sessions:** existing records keep text-only `resultText`; nothing migrates, and they recover text only. New image reads carry a marker, so they never dedup-alias legacy image records.
- **Multiple occurrences per id:** each occurrence's markers select its own images.
- **Same pixels in several results:** any matching block is byte-identical, so which one the index keeps does not matter.
- **Hash precision:** 8 hex chars = 32 bits; collision odds ~1 in 4 billion per pair, adequate for a same-session key. The dedup SHA-1 in `src/content-hash.ts` still hashes the full normalized text.
- **Hashing cost:** one sha256 per branch image per query call; screenshot sessions hold tens of images, well under the cost of the LLM turn that issued the query.
- **Protected results inside compressed chains:** their relocated text now carries the marker instead of silently dropping the image. They are never indexed, so they gain no image recovery.
- **Branch read failure:** `getBranch()` is a synchronous in-memory read; the design adds no error handling around it.

## Tests

`bun test src/`:

| File | Case |
|---|---|
| `src/batch-capture.test.ts` | markers lead the text, in block order, with mime type and 8-hex hash; same base64 -> same marker, different base64 -> different marker; text-only content unchanged; a result with >2,000 text chars plus an image keeps the marker in `serializeBatchForSummarizer` output; capturing two `read` results with identical text and different `data` misses `lookupByContent`, identical `data` hits |
| `src/summarizer.test.ts` | the system prompt the summarizer passes to the model contains the image sentence |
| `src/query-tool.test.ts` | harness passes `ctx = { sessionManager: { getBranch: () => branch } }`; record with a marker whose image is on the branch -> content ends with that image block, for a short ref, an explicit `id@timestamp`, and a bare alias id; record without a marker (legacy) -> text only; marker whose image is off-branch -> text only; pre-change alias over two different PNGs -> text only; description mentions image blocks |
| `src/pruner.test.ts` | `sizeMessages([msg]) === charsOf(msg)` for an image-bearing message, far below its `JSON.stringify` length |
| `src/context-metrics.test.ts` | existing image fixture covers the exported `charsOf` |

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: PRUNING.md (content-hash dedup: image marker is part of the key; `context_tree_query` recovery returns original image blocks by marker hash; "Live reclaim ratio" bullet: `sizeMessages` sums `charsOf`, flat 1,600-token image estimate), README.md (`context_tree_query` row: recovers images), CHANGELOG.md (`[Unreleased]` Fixed entry)
- Derived / memory docs invalidated: none

Classified per `reference/documentation-impact.md`.

## Out of scope

- `/pruner compact` notification size (`src/commands.ts`, sums `resultText.length`; understates, never inflates).
- `/pruner now` progress `rawChars` and `minBatchChars` thresholds.
- Sending images to a vision-capable summarizer.
- Image recovery for protected results relocated by chain-range-prune.
- Persisting image data in index records or spill sidecars.
- Protecting fresh image results from a flush for one turn.

## Open questions

none
