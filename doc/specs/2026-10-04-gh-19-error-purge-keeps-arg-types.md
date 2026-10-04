# Error purge keeps argument shape (#19)

**Goal:** Error purge shrinks the large string values inside a failed tool call's arguments instead of replacing the whole arguments object, so every key, JSON type, and array length survives and pi-ai's request building no longer throws on grammar-constrained tools (`codemode`), while the purge still reclaims the bulk of the space.

Ticket: https://github.com/jjuraszek/pi-condense/issues/19

## Problem

`purgeErroredArgs` (`src/error-purge.ts:58-62`) replaces a qualifying failed call's `arguments` with `{ _purged: "<purged-errored-args size=\"N\"/>" }`. That drops every original key. pi-ai's `getGrammarToolInput` (`@earendil-works/pi-ai/dist/api/constrained-sampling.js:1-7`, identical in the repo's 0.83.0 and in host pi 1.0.2) throws `Grammar tool call "codemode" requires argument "code" to be a string.` unless `arguments[inputProperty]` is a string; it runs on every history replay through Chat Completions (`dist/api/openai-completions.js:902`) and Responses/Codex Responses (`dist/api/openai-responses-shared.js:185`). Host pi 1.0.2's `codemode` tool declares `constrainedSampling: { type: "grammar" }`, so once a failed codemode call passes the cooldown, every later request on an OpenAI grammar-tool model fails at request building, and every retry re-applies the same purge. The reporter counts 15 sessions and 41 failed requests.

Verified premises: the mechanism above is confirmed from source. The `context` event payload (`ContextEvent { type: "context"; messages }`) carries no tool definitions, so a grammar-aware exclusion is not expressible without hardcoding tool names; the fix must be tool-agnostic and shape-preserving. Nothing in production reads the `_purged` key - only tests and `PRUNING.md` - so the stub shape has no hidden consumer. The reporter's transport-level reproduction is not reproduced here; acceptance row 4 covers it.

## Acceptance criteria

Ticket #19, `## Acceptance criteria`, rows verbatim:

- [ ] Running `purgeErroredArgs` on the reporter's repro history (failed codemode call, `code` of about 1,000 characters, two later assistant turns, `cooldownTurns: 2`, `minArgChars: 500`) leaves `arguments.code` a string, the call's arguments serialize to under 500 characters, and `getGrammarToolInput("codemode", args, "code")` returns without throwing.
  in-scope
- [ ] For a purged failed call, every top-level argument key present before the purge is still present and keeps its JSON type, for both a `write`-shaped call (`{ path, content }`) and an `edit`-shaped call (`{ path, edits: [...] }`).
  in-scope
- [ ] Purging still reclaims space: a failed `write` call whose `content` is 30,000 characters, and a failed `edit` call whose `edits` hold 30,000 characters of text, each serialize to under 500 characters after the purge.
  in-scope (reading: the `edit` fixture holds its 30,000 characters in a small number of `oldText`/`newText` values, each over the per-string floor; see Design "Known limit")
- [ ] A pi-ai request built from a pruned history that declares a grammar-constrained `codemode` tool on a model with `supportsOpenAIGrammarTools: true`, and contains a failed codemode call past the cooldown, gets past request building: against an unreachable endpoint it fails with a connection error, not the grammar error.
  in-scope

## Design

### Approaches considered

1. **Recursive in-place string shrink (chosen).** Keep the trigger unchanged; walk `arguments` recursively and replace only large string values with a placeholder string. Tool-agnostic, needs no tool definitions, preserves every key, type, and array length. One function body changes.
2. **Top-level-only shrink plus container compaction** (large arrays -> `[]`, large objects -> `{}`). Meets the ticket's literal "top-level key and type" wording but destroys an `edit` call's `edits` length and inner structure for no extra reclaim, and adds a second rule to document. Rejected.
3. **Hardcoded grammar-tool allowlist** (`codemode` -> keep `code`). Fixes only the reported symptom; the ticket excludes new exclusion settings, the `context` event gives no tool schema, and any other grammar tool breaks the same way. Rejected.

### Component

Single component: `purgeErroredArgs` in `src/error-purge.ts`. Pass 1 (errored `toolCallId` -> assistant turn index) and the block-level eligibility checks (matching `isError: true` result, `cooldownTurns` elapsed, `JSON.stringify(block.arguments).length >= minArgChars`) are unchanged. The replacement at lines 58-62 becomes a call to a module-private `shrinkStrings(value): [value, changed]`:

- a string whose `length > PURGE_STRING_MIN_CHARS` (constant, `200`) maps to `<purged-errored-args size="${original.length}"/>`;
- an array recurses over its elements; a plain object recurses over its own enumerable keys in iteration order; each is shallow-copied only when a child changed, otherwise returned by identity;
- numbers, booleans, `null`, and strings of 200 chars or fewer are returned as-is.

The block is rewritten (`{ ...block, arguments: shrunk }`) only when `shrinkStrings` reports a change; otherwise the block is returned by identity so the pruner's `afterPurge !== current` contract in `src/pruner.ts:159-166` still holds and `pruned` stays false. `shrinkStrings` is applied to `block.arguments` whatever its JSON type; no special case for a non-object top level. The original `arguments` tree is never mutated.

Data flow is unchanged: `pruneMessages` phase 2 calls `purgeErroredArgs` on the render copy; the session file never sees the stub. `ErrorPurgeConfig`, `DEFAULT_CONFIG.purgeErrors`, and `minArgChars`'s whole-body meaning are untouched. `PURGE_STRING_MIN_CHARS` is not configurable: the floor exists to keep `path`, short `command`, and small `newText` values readable, which a user has no reason to tune, and a setting for the corner case would outlive the fix. The two thresholds are independent: `minArgChars` decides whether a failed call's body is scanned, the 200-char floor decides which strings inside it are replaced; with the shipped `100` preset (`PURGE_MIN_ARG_PRESETS`, `src/types.ts:163`) a body between 100 and ~210 chars is scanned and left unchanged. The placeholder keeps the existing `<purged-errored-args size="N"/>` text, now per value rather than per call.

Before/after on the fixtures:

| Call | Before | After |
|---|---|---|
| codemode `{ code: <1000 chars> }` | `{ _purged: "<purged-errored-args size=\"1012\"/>" }` | `{ code: "<purged-errored-args size=\"1000\"/>" }` |
| write `{ path: "src/foo.ts", content: <30000> }` | `{ _purged: ... }` | `{ path: "src/foo.ts", content: "<purged-errored-args size=\"30000\"/>" }` |
| edit `{ path, edits: [{ oldText: <15000>, newText: "x" }, { oldText: "y", newText: <15000> }] }` | `{ _purged: ... }` | `{ path, edits: [{ oldText: "<purged...15000/>", newText: "x" }, { oldText: "y", newText: "<purged...15000/>" }] }` |

### Known limit

A block that qualifies by whole-body size but contains no string over 200 chars (a 600-key object of short values; an `edits` array of hundreds of tiny entries) is returned by identity and reclaims nothing. This is accepted: the purge targets large bodies, and compacting containers would reintroduce the shape loss this fix removes.

Residual risk, unverified: the fix removes pi-ai's client-side throw. Whether an OpenAI endpoint accepts a replayed `custom` tool call whose `input` is the placeholder (sent verbatim, `dist/api/openai-completions.js:895-905`) rather than text matching the declared lark/regex grammar is server behavior no in-repo test can cover; if the server validates history inputs the failure would move to an HTTP 400. Ask the reporter to confirm on a real endpoint after release.

## Errors and edge cases

- `shrinkStrings` never throws. Input is plain JSON from `JSON.parse` of provider output, so cycles cannot occur and no cycle guard is added.
- A string of exactly 200 chars stays verbatim; 201 is shrunk (strict `>`).
- `size` reports `string.length` (UTF-16 code units), matching the existing `argBody.length` convention.
- Already-shrunk output never re-qualifies per value: the placeholder is ~35 chars, under the floor, so a second render pass over purged output is byte-identical and returns the same reference. The whole-body gate may still be true for the shrunk body when `minArgChars` is tiny (tests use 5-10), but with no string over the floor the block is returned by identity.
- Object key order is preserved by iteration copy, so serialization is deterministic across passes.
- Nested `oldText`/`newText` are judged independently; a long `oldText` beside a short `newText` keeps the short one.
- Non-string scalars (`line: 42`, `force: true`, `null`) pass through by identity.
- Successful calls, calls inside the cooldown, and bodies under `minArgChars` are untouched exactly as today; tool results and the `isError` signal are never modified.

## Tests

`src/error-purge.test.ts` - replace the `_purged` assertions at lines 74-77, 132-135, 171, and update the fixtures: every existing positive fixture (lines 62, 109, 160) holds strings of 30-45 chars, under the new floor, so the purge would return identity and `not.toBe(messages)` would fail. Positive, cooldown, success, and non-mutation fixtures move to strings over 200 chars (`"x".repeat(300)`); the under-`minArgChars` guard keeps a body below `minArgChars` but with a string above the floor; a string of exactly 200 chars is reserved for the boundary no-op case. Add:

1. codemode `{ code: "x".repeat(1000) }`, `cooldownTurns: 2`, `minArgChars: 500`, two later assistant turns: `typeof arguments.code === "string"`, `Object.keys` unchanged, `JSON.stringify(arguments).length < 500`, and `getGrammarToolInput("codemode", arguments, "code")` imported from `@earendil-works/pi-ai/api/constrained-sampling` (the exported subpath; `dist/api/...` is not in the package `exports` map) returns without throwing (rows 1, 4-helper). The `getGrammarToolInput` assertion lives in the row-4 transport test file, which already imports pi-ai; the shape assertions stay in `src/error-purge.test.ts`.
2. write `{ path: "src/foo.ts", content: "x".repeat(30000) }`: `path` byte-identical, `content` is the placeholder string, serialized body under 100 chars (rows 2, 3).
3. edit with two entries as in the Design table: `edits.length === 2`, each entry's keys and types preserved, only the two long values shrunk, serialized body under 500 chars (rows 2, 3).
4. mixed scalars `{ n: 42, b: true, z: null, s: "short", big: <201> }`: `typeof`/value checks per key; only `big` changes.
5. eligible body with only short strings (whole body over `minArgChars`): returned message array `toBe` the input.
6. second pass over purged output: `toBe` the first pass's result.
7. existing identity/non-mutation tests kept; add `toEqual` on a deep clone of the original nested arguments after purge.

`src/pruner.test.ts` - the fixtures at lines 281 and 1012 are `{ content: "x".repeat(200) }` (exactly the floor, no `path`); both become `{ path: "src/foo.ts", content: "x".repeat(300) }`. The wiring assertion at line 347 changes from `arguments._purged` to `arguments.content` matching `/^<purged-errored-args size=/` with `path` byte-identical.

Row 4 - transport test in `src/error-purge.test.ts` (or a sibling file if the import surface warrants it). pi-ai does not reject on provider failure: `dist/api/openai-completions.js:450-451` catches, sets `stopReason: "error"` and `errorMessage`, and the stream resolves with that message, so the test awaits a result, never a rejection. Setup: import `stream` from `@earendil-works/pi-ai/api/openai-completions`; model with `api: "openai-completions"`, `compat: { supportsOpenAIGrammarTools: true }` (the flag is read from `model.compat`, not the model root; `detectCompat` would otherwise set it false), `baseUrl: "http://127.0.0.1:9"`, dummy API key, and the `fetch` stream option (`StreamOptions.fetch`, `dist/types.d.ts:57`) set to a stub that records the call and rejects - no socket is opened, so the result is identical on the Windows CI runner; the OpenAI SDK (6.26.0, `node_modules/openai/src/client.ts:681`) wraps any fetch rejection in `APIConnectionError` and drops its message, so pi-ai reports `Connection error.` and the stub's call count, not its message, is the proof that request building reached the network step; a `codemode` tool whose schema has one required string property `code` and `constrainedSampling: { type: "grammar", variants: { openai_lark: "<non-empty grammar>" } }` (a grammar with no variant throws `no supported grammar variant was provided` before the network call); a pruned history with the failed codemode call past the cooldown; `maxRetries: 0`. Assert on `await stream(...).result()`: `stopReason === "error"`, `errorMessage` matches `/Connection error/`, the fetch stub was called once, and `errorMessage` does not match `/Grammar tool call/`. Negative control: the same history with the old `{ _purged }` shape yields `errorMessage` matching `/Grammar tool call/` and the fetch stub is never called (the throw at `openai-completions.js:902` happens inside `buildParams`, before the request), proving the test exercises the grammar path. One transport suffices (Responses shares the same `getGrammarToolInput` call per the Problem section).

Gate: `bun test src/` and the AGENTS.md typecheck command.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` § Error Purge (communication contract: the output example, the "does NOT touch" list, the per-string floor and the rationale for keeping it a constant, and the `minArgChars` row at line 1130 stating that qualifying bodies are scanned and only strings over 200 chars are replaced); `CHANGELOG.md` - add `## [Unreleased]` / `### Fixed` entry referencing #19 in this change (the section does not exist yet; `release.sh` requires it non-empty, so deferring would leave the release prerequisite unmet)
- Derived / memory docs invalidated: `doc/configuration.md` `purgeErrors.enabled` row at line 73 ("Replace failed toolCall argument bodies with compact stubs") and `purgeErrors.minArgChars` row at line 75 (scan-versus-shrink distinction), plus the same `enabled` wording in the settings overlay at `src/commands.ts:678` - all now misleading; one-line fixes

Materiality bar: pi-gauntlet brainstorming `reference/documentation-impact.md`. `README.md` and `AGENTS.md` do not describe the stub shape and stay as they are.

## Out of scope

- Making purge honor `protectedTools`/`protectedPaths`, or a `purgeErrors.excludeTools` setting (excluded by the ticket).
- Making `PURGE_STRING_MIN_CHARS` configurable.
- Changing whether summarized errors (phase 1 stubs with `isError: false`) are eligible for purge.
- Any dependency or pi-ai change.
- Reclaiming space from bodies made only of short strings (Known limit).
- Server-side acceptance of the placeholder as grammar input (Residual risk; reporter confirmation).

## Open questions

none
