# Pruner no-op serialization + fast-path comment fix

Fixes [issue #4](https://github.com/jjuraszek/pi-condense/issues/4). Two coupled corrections in the render-time prune path plus a folded-in dependency refresh.

## Problem

`pruneMessages` (`src/pruner.ts`) runs on every main-loop render. It computes `const beforeChars = sizeMessages(messages)` **unconditionally** at line 72 - a full `JSON.stringify(messages).length` over the entire context - before any pruning phase runs. On a no-op render (nothing to prune) that serialization is pure waste: the result is returned as both `beforeChars` and `afterChars` but the sole consumer never reads them on the no-op path.

Cost is CPU/GC only (zero token cost), and it is narrower than it first looks: at large context under the default config, phase 4 (thinking-strip) fires most turns, so `pruned` is usually `true` and `beforeChars` **is** consumed. The wasted serialization bites on small sessions and genuine no-ops.

Separately, the fast-path comment at `index.ts:820-823` is wrong: it claims the fast path triggers "when both the tool-call index and chain registry are empty." Phases 2 (error-purge) and 4 (thinking-strip) prune independently of index/registry state, so that emptiness does not imply a no-op. The comment is worth correcting regardless of the serialization fix, and the two belong in one change.

## Non-goals

- **Removing the phase-1 `.map()`** (`src/pruner.ts:76`). It allocates an N-pointer array, not a deep copy; skipping it needs a pre-scan and is not worth it. Asymptotically it is O(n) pointer copies against the O(total serialized bytes) of the `JSON.stringify` this spec removes - a different order of magnitude, so the `.map()` is not the win here.
- **Coupling to issue #1** ("fast-path predicate covers all four phases"). Speculative; dropped.
- **CI node pinning.** `test.yml` is bun-only (no node pin) and `release.yml` pins node 24; leave both as-is.
- **Any Python work.** There is no Python in this repo (confirmed: no `.py`, `pyproject.toml`, `requirements.txt`, `.python-version`, mise/`.tool-versions`, or Python in CI/scripts). pi-condense is pure TS/Bun/Node.

## Ground truth (verified against source)

- `src/pruner.ts:71` return type is inline: `{ messages: any[]; pruned: boolean; beforeChars: number; afterChars: number }`. JSDoc (lines 33-61) documents phases + `pruned`/`messages` but not `beforeChars`/`afterChars`.
- `src/pruner.ts:161` currently returns `{ messages: current, pruned, beforeChars, afterChars: pruned ? sizeMessages(current) : beforeChars }`.
- `sizeMessages` (`src/pruner.ts:15-17`): `JSON.stringify(messages).length`; deliberately serializes hidden fields (thinking, tool args, tool-result arrays).
- **Mutation invariant (load-bearing):** no phase mutates the input `messages` in place. Phase 1 builds `next` via `.map()` and sets `current = pruned ? next : messages`; phase 2 (`error-purge.ts:60`) returns `messages` unchanged when inactive; phase 3 (`chain-range-prune.ts`) builds a fresh `out`; phase 4 (`thinking-strip.ts:37`) returns `messages` unchanged when inactive. Therefore `sizeMessages(messages)` evaluated at return time equals its value at entry - moving the call into the pruned branch is behavior-preserving.
- **No-op path is `JSON.stringify`-free apart from the `beforeChars` line:** with default `recoveryGraceTurns=0`, `inGraceRecoveryToolCallIds` returns immediately without serializing; phase-1 `.map` and all phase gates use no serialization. So removing line 72's call makes a no-op perform zero `JSON.stringify` over the message array.

### Consumers of `beforeChars` / `afterChars`

- `index.ts:836` `statsAccum.setLiveReclaim(result.beforeChars, result.afterChars)` - **gated on `result.pruned`** (`index.ts:835`). Never runs on a no-op, so `{0,0}` on the no-op path is never read.
- `src/commands.ts:63` `pruneStatusText` reads the stored `LiveReclaim` and guards `if (!reclaim || reclaim.beforeChars <= 0) return "prune: ON"`. `LiveReclaim` (`src/types.ts:695-698`) is only ever fed by `setLiveReclaim`, i.e. only from the pruned path.
- `commands.test.ts:28-29` already asserts `{beforeChars:0, afterChars:0} -> "prune: ON"`. The `{0,0}` sentinel is already an accepted input shape downstream.

## Design

### 1. Core fix - `src/pruner.ts`

Remove the unconditional `const beforeChars = sizeMessages(messages)` at line 72. Compute both sizes lazily in the pruned branch only, and return the `{0,0}` sentinel on no-op:

```ts
return pruned
  ? { messages: current, pruned, beforeChars: sizeMessages(messages), afterChars: sizeMessages(current) }
  : { messages, pruned, beforeChars: 0, afterChars: 0 };
```

Net effect: a no-op render performs zero `JSON.stringify` over the message array. The pruned path is unchanged (still two serializations: input and output). This is **non-breaking** for consumers: the return shape is identical, and the only reader of the size fields (`index.ts:836`) is gated on `result.pruned`, so it never observes the `{0,0}` sentinel; `pruneStatusText` already treats `beforeChars <= 0` as "no reclaim data yet".

Approaches considered: (A) `{0,0}` sentinel - chosen; (B) lazy getter fields; (C) optional fields dropped on no-op. B and C add type churn and touch consumers for a CPU-only win. A keeps the flat return shape and matches the issue AC.

### 2. Field-semantics JSDoc - `src/pruner.ts:33-61`

Extend the existing JSDoc to document the two size fields: when `pruned` is `true` they are the serialized-context sizes before and after pruning; when `pruned` is `false` both are `0` - a no-op sentinel, not a measurement. Match the existing comment style in the file (no banner comments).

### 3. Fast-path comment fix - `index.ts:820-823`

Replace the inaccurate claim ("fast path when the tool-call index and chain registry are empty") with the truth: phases 2 (error-purge) and 4 (thinking-strip) can prune regardless of index/registry state, so `pruned` reflects any of the four phases firing - index/registry emptiness alone does not imply a no-op.

### 4. Dependency refresh - `package.json`

- `engines.node`: `>=20.3.0` -> `>=22.19.0`, matching the host pi runtime (`@earendil-works/pi-coding-agent@0.83.0` declares `engines.node: >=22.19.0`). This is the one real "match current pi recommendation" gap; it drops advertised support for Node 20/21, which pi itself no longer runs on. Consumer impact: no CI or runtime impact (the test/release pipeline is Bun-only), but `npm install` under Node <22.19.0 will now warn (or fail under `engine-strict`) - acceptable, since such a Node can't run the host pi anyway.
- Preserve `package.json`'s trailing newline when editing (it ends with `}\n` in HEAD); do not let an editor strip it.
- `@sinclair/typebox`: floor `^0.34.49` -> `^0.34.52` (latest; the caret already resolved to `.52`, so this is a freshness-only bump with no resolution change).
- `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`: left at `^0.83.0` (already the latest published; == host runtime).

This is an independent workstream from the pruner fix, folded into one change at the user's request; both are small.

## Edge cases

- **Empty input** (`messages = []`): no-op path returns `{0,0}`. Correct - no serialization needed.
- **Reverted fix regression:** if a future change moves `sizeMessages(messages)` back to the unconditional path, `beforeChars` becomes nonzero on a no-op and the rewritten test (below) fails. This is the intended guard.
- **`prune: ON` status:** unaffected - `pruneStatusText` already treats `beforeChars <= 0` as "no reclaim data yet" and the live-reclaim store is only written from the pruned path.

## Testing

Runner: `bun test src/` (per AGENTS.md).

- **Rewrite `src/pruner.test.ts:593-601`** (the no-op case). It currently asserts `beforeChars === afterChars === sizeMessages(input)` - the exact behavior being removed. New assertion, with a **non-empty** input: no-op returns `{ pruned:false, beforeChars:0, afterChars:0 }`. This asserts the return contract, not the serialization-skip directly. What it catches: the realistic regression where `sizeMessages(messages)` is moved back to the unconditional path *and consumed* into `beforeChars` (the pre-fix code shape) - the non-empty input then yields nonzero and the test fails. Accepted residual gap: a contrived regression that calls `sizeMessages(messages)`, discards the result, and still returns the `{0,0}` sentinel would pass this test while re-introducing the CPU cost. A `JSON.stringify` call-count spy would close that gap but was **rejected** as disproportionate for a CPU-only micro-opt (it would also couple the test to every phase's internal gating and false-positive on any future legitimate cheap serialization on the path). This is an informed decision, not an oversight.
- **Pruning-path test (`src/pruner.test.ts:603-623`)** stays valid and unchanged - it asserts real `beforeChars`/`afterChars` values on a pruning render.
- **`sizeMessages` test (`src/pruner.test.ts:571-589`)** unchanged.

Verification commands:
- `bun test src/` - all green.
- Typecheck per AGENTS.md: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`.
- `bun install --no-save` - resolves clean under the bumped `engines.node` and typebox floor. Use `--no-save` (or delete the generated `bun.lock` afterward): the repo tracks no lockfile and `.gitignore` excludes only `package-lock.json`, so a bare `bun install` under Bun 1.3.x leaves an untracked `bun.lock`.
- `git status --porcelain` after the above - confirm no stray files (e.g. `bun.lock`) beyond the intended edits.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: CHANGELOG.md (fix entry: no-op zero-serialization + corrected fast-path comment; plus `engines.node` bump to `>=22.19.0` and typebox floor bump). `src/pruner.ts` JSDoc field semantics (implementation surface, in the same change).
- Derived / memory docs invalidated: none (no AGENTS.md routing, PRUNING.md algorithm, or README config surface changes - the return shape and phase behavior are unchanged, only the no-op field values and an inaccurate comment).
