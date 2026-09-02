# Spill sidecar filename cap (gh-14)

Fixes ENAMETOOLONG when spilling oversized tool results for providers whose
tool-call ids run to hundreds of characters. GitHub issue:
[jjuraszek/pi-condense#14](https://github.com/jjuraszek/pi-condense/issues/14).

Partially supersedes
[doc/specs/2026-06-02-oversized-output-spill.md](./2026-06-02-oversized-output-spill.md)
- sidecar filename derivation and filename-collision handling. The rest of that
spec (spill trigger, atomicity, stub format, read-back) remains current. Note:
that spec's collision clause (probe for an existing target, fall back inline)
was never implemented - both writers call plain `writeFile` with no existence
probe. This spec supersedes it for the capped branch with a
disjoint-by-construction namespace (below) and leaves the short-key behavior
as status quo.

## Problem

`blobPathFor` (`src/spill.ts:17-19`) builds the sidecar basename as
`${sanitizeId(occurrenceKey)}.txt` with no length cap. Occurrence keys embed the
provider tool-call id (`id@resultTimestamp`, `src/occurrence-key.ts`), and some
providers emit ids of 300+ characters. Basenames over 255 bytes make `writeFile`
fail with ENAMETOOLONG on the eager spill path (caught, result stays inline and
bloats context - `src/spill.ts:87-90`) and abort the deterministic backfill path
(thrown, fail-closed - `src/indexer.ts:533-537`).

## Change

All code changes live in `src/spill.ts`. `blobPathFor` keeps its signature;
`sanitizeId` is untouched; callers are untouched.

Inside `blobPathFor`, with `base = sanitizeId(toolCallId)`:

- If `Buffer.byteLength(base, "utf8") <= 251` (255 minus `.txt`): basename is
  `${base}.txt` - byte-identical to today for every key that currently works.
- Else: basename is `${prefix}.${hash}.txt`, exactly 255 bytes, where:
  - `hash` = `createHash("sha1").update(toolCallId).digest("hex").slice(0, 16)`
    over the **original unsanitized occurrence key string** as passed in
    (`node:crypto`; matches the repo's sha1-hex convention in
    `src/content-hash.ts` and the 16-hex truncation in `src/pruner.ts:188`);
  - `prefix` = `base.slice(0, 234)` (sanitized alphabet is ASCII, so slice
    counts bytes); 234 = 255 - 4 (`.txt`) - 17 (`.` + 16-hex hash).

The `.` separator is deliberate: `sanitizeId` maps `.` to `_`, so no sanitized
short key can ever contain a `.` before the `.txt` suffix. Capped names are
therefore disjoint by construction from every uncapped basename - a capped
long key can never silently overwrite an unrelated short key's sidecar (both
writers use plain non-exclusive `writeFile`, so namespace disjointness is the
only collision guard).

The only new import is `createHash` from `node:crypto`.

### Why these choices

- **Hash the unsanitized key**: two distinct keys that sanitize identically
  (e.g. differing only in characters `sanitizeId` maps to `_`) still get
  distinct filenames. Same key always maps to the same name - pure function of
  the key string, no counters, no fs-existence probing.
- **Conditional cap, not blanket hashing**: keys already under the limit keep
  their current filenames, so existing sessions see zero churn.
- **Cap inside `blobPathFor`**: both sidecar writers - eager spill
  (`src/spill.ts:82`) and chain backfill (`src/indexer.ts:533`) - call it, so
  they inherit the fix with no call-site changes and cannot drift apart.

## Non-changes (explicit)

- `sanitizeId` semantics (directory-escape safety) unchanged.
- Failure semantics of both writers unchanged: eager spill still
  catch-and-continue, backfill still fail-closed throw.
- Read-back unchanged: `context_tree_query` reads persisted `record.spillPath`
  verbatim (`src/query-tool.ts:63-75`) and never re-derives paths. No
  migration, no renaming of existing sidecar files; `reconstructFromSession`
  replays persisted paths as-is.
- Short-key formatting unchanged: the existing literal assertion
  `.endsWith("bash_23_1150.txt")` in `src/spill.test.ts` must keep passing.

## Edge cases

- `base` exactly 251 bytes: uncapped (boundary covered by tests).
- Legacy bare ids (no `@timestamp` suffix): same rule; old bare-id sidecars
  remain readable via their persisted `spillPath`.
- Two long keys colliding on both the 234-byte prefix and the 16-hex hash:
  accepted risk (~2^-64 per pair), consistent with existing truncated-hash
  conventions in this repo.

## Acceptance criteria (from issue #14)

1. A 500-char tool-call id spills successfully via `spillOversizedBatch`:
   sidecar file created, basename <= 255 bytes, and the captured record
   mutated - `resultText === ""`, `resultPreview` set, `spillPath` pointing at
   the file. (The LLM-facing pointer stub is emitted later by `pruneMessages`
   and is not part of this unit-scoped criterion.)
2. Same 500-char id at two occurrences (different `resultTimestamp`) produces
   two distinct sidecar files, each reading back its own output.
3. Two distinct 500-char ids sharing the first 300 characters map to distinct
   filenames (prefix-only truncation disallowed).
4. A long-id record survives the full backfill -> restart round trip, as one
   explicit I/O sequence: drive it through `backfillChainRecords`
   (`src/indexer.ts:521-538`; assert no throw and basename <= 255 bytes),
   persist the index entry, rebuild a fresh indexer via
   `reconstructFromSession`, then `readFile(restored.spillPath)` equals the
   original body - not merely calling the path helper twice, and not a
   reconstruct-only test that skips the backfill write.
5. A key whose current basename fits 255 bytes produces the same filename as
   today; boundary tests cover just-under (unchanged) and just-over
   (capped+hashed).

## Testing

`bun:test`, added to existing files only:

- `src/spill.test.ts`: AC1, AC2, AC3, AC5 boundary pair (251-byte base ->
  unchanged formula; 252-byte base -> capped, exactly 255 bytes with `.txt`),
  determinism (`blobPathFor` twice with the same long key -> identical path).
  All existing assertions (short-key literal, legacy bare-path compat, failure
  atomicity) keep passing untouched.
- `src/oversized-spill.integration.test.ts`: AC4 as the explicit sequence
  above (`backfillChainRecords` write -> persist -> fresh indexer
  `reconstructFromSession` -> `readFile(spillPath)` equals original body).
  Plus a namespace-disjointness regression: a long key whose 234-byte capped
  prefix equals an existing 251-byte short key's basename stem still maps to a
  distinct filename (the `.` separator guarantees it).

Verification: `bun test src/` plus the repo typecheck command from AGENTS.md.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` sidecar-contract paragraph
  (one sentence: over-limit basenames are capped at 255 bytes as
  `<prefix>.<16-hex sha1 of the occurrence key>.txt`)
- Derived / memory docs invalidated: none

Plus the supersession banner on
`doc/specs/2026-06-02-oversized-output-spill.md` (scope: sidecar filename
derivation only), shipped in the same commit as this spec.

## Out of scope

- Reconciling the eager-path `console.error` vs the old spec's "debug" wording
  (adjacent, independent).
- Collision checks for short sanitized keys (pre-existing status quo; two
  distinct short keys that sanitize identically still collide, as today). The
  old spec's probe-and-fall-back-inline clause stays unimplemented; the capped
  branch needs no probe because its namespace is disjoint by construction.
- Any read-time path re-derivation or sidecar migration.
