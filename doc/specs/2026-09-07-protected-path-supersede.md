# Protected-path supersession: only the newest read of a protected path stays verbatim

Date: 2026-09-07
Status: approved for planning
Predecessor: [`doc/specs/2026-06-11-protected-paths.md`](./2026-06-11-protected-paths.md) - partially superseded (the "stays verbatim in context forever" edge case)

## Problem

Protected reads (`protectedPaths`, default `**/skills/**/*.md` + `**/gauntlet-overrides.md`) are filtered out of the capture pipeline at `index.ts:872` before content dedup at `index.ts:335`. They are never indexed, never deduped, never summarized. Every re-read of the same skill file is delivered verbatim for the rest of the session - once raw, then relocated into a `<compressed-chain>` body as `<protected-output>` when chain compression covers it.

Evidence (session `agent.balanced/.../2026-09-06T16-03-01-284Z_01a07775...jsonl`, replayed offline through `pruneMessages`):

- 4.29 MB raw -> 1.08 MB delivered; ~405 KB (55% of delivered) is protected skill/overrides `.md` content.
- `subagent-driven-development/SKILL.md` read twice, byte-identical (29358 B, hash `a7aedf2eeb10b2e2`) - both delivered.
- `pi-cohort/skills/pi-cohort/SKILL.md` read 3x as different `offset`/`limit` slices (23314 / 52022 / 4931 B) - all delivered.
- 0 `context-prune-dedup-alias` entries exist for protected ids (34 exist for unprotected results).

Protection's goal is "the model must have this content verbatim". A second copy of the same file adds zero information. Only the newest read of a path needs to remain verbatim.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| a | Identity = the raw `args.path` string (same normalization as `src/protected.ts`: backslash -> slash, no resolution). `offset` / `limit` ignored. | Matches "only the newest version of the file"; skill files are read whole in the vast majority of cases. A later slice supersedes an earlier full read; the model re-reads if it needs an older slice. |
| 1 | A superseded read becomes a deterministic one-line stub. Zero LLM calls, no `cost:external` change. | The newest copy is verbatim in context; summarizing the old one adds nothing. |
| A | Render-time positional rule inside `pruneMessages`; no persisted session entry, no indexing of protected calls. | Works instantly on pre-existing sessions and after `session_start`; self-heals when the newer read is deleted or branched away. |
| ii | Cadence: a superseded read is stubbed only when the pruner is already rewriting at or before its position, plus all-pending activation on five cold-cache events. Between those moments a freshly superseded copy stays verbatim on purpose. | A mid-prefix rewrite at 30% depth re-bills ~70% of context at full price once; a 7k-token duplicate costs ~700 token-equivalents/turn at cached rate. Break-even is 150+ turns - a deliberate cache miss is never worth it. |
| - | Recovery for a superseded read is "re-read the file". No `t<N>` ref, no `context_tree_query` support. | `context_tree_query` (`src/query-tool.ts:38`) needs an index record; indexing protected calls is new machinery. Skills and overrides are files on disk. |
| - | Scope: any protected call (by `protectedPaths` or `protectedTools`) whose arguments carry a string `path`. Tool-name-protected calls without `path` never participate. | Path is the identity; without one there is nothing to supersede. |

Real-session timing check: of the 4 re-reads in the evidence session, 3 happened hours after the first read's chain had compressed - the pruner never rewrites that far back again. Only the same-batch pi-cohort slice pair (52 KB) is caught by the rewrite rule alone; the cold-cache events catch the rest (the session JSONL had 8 `model_change` entries - the extension hook for that moment is `model_select`).

## Architecture

Supersession is a new phase **1b** inside `pruneMessages` (`src/pruner.ts`), between phase 1 (stub-replace) and phase 2 (error-purge). It rewrites only the message array the pruner returns; the session JSONL is never modified.

### `src/supersede.ts` (new, pure)

```ts
export interface SupersededCandidate {
  toolCallId: string;
  path: string;
  timestamp: number | undefined; // resultTimestampOf(result.timestamp); undefined on pre-2026-08-12 sessions
  resultIndex: number;           // index of the ToolResultMessage in `messages`
}

export function findSuperseded(
  messages: AgentMessage[],
  isProtected: (toolName: string, args: unknown) => boolean,
): SupersededCandidate[];
```

Walks assistant `toolCall` blocks in order. Args are read with the house fallback `block.input ?? block.args ?? block.arguments ?? {}` (pi-ai `ToolCall` exposes `arguments`; older session shapes differ). A call participates when `isProtected(name, args)` is true, `args.path` is a string, **and** a `ToolResultMessage` with `toolCallId === block.id` exists in `messages` (same pairing `captureBatch` uses). Calls without a paired result never participate - neither as winner nor as candidate - so an aborted turn (call without result, the case pi-ai's `insertSyntheticToolResults` repairs) cannot steal the win and leave zero verbatim copies. Paths are normalized backslash -> slash via `normalizePath`, exported from `src/protected.ts` (today inlined in `isProtected` at `protected.ts:49`; the export is the only change to that file, and `isProtected` calls it). Per path, the **last** participating occurrence is the winner and is never returned; every earlier participating occurrence is a candidate.

### `SupersedeState` (mutable, owned by `index.ts`)

```ts
export interface SupersedeState {
  floor: number | undefined;  // earliest result timestamp the NEXT render will rewrite
  activated: Set<string>;     // occKey(toolCallId, resultTimestamp) of stubs that have taken effect
}
```

Defined in `src/supersede.ts` next to the pure function; a single instance lives in `index.ts` for the session.

- `floor` is written as `state.floor = state.floor === undefined ? t : Math.min(state.floor, t)` - only ever lowered within a turn - and consumed once by the next `context` call, which resets it to `undefined`.
- `activated` is keyed by `occKey(toolCallId, resultTimestampOf(result.timestamp))` (`src/occurrence-key.ts`), degrading to the bare id when the timestamp is missing - the same discriminant the rest of the repo uses because provider tool-call ids are reused across turns. In-memory only. Once an id is in, it stays for the session. Cleared on `session_start` and `session_tree` before the `floor = 0` rebuild, so ids cannot leak across branches. Nothing is persisted: after a restart the `session_start` floor re-activates everything eligible anyway.

### Phase 1b in `pruneMessages`

`pruneMessages` gains one trailing optional parameter `supersede?: { state: SupersedeState; isProtected: (toolName: string, args: unknown) => boolean }`. When absent, the phase is a no-op (existing tests unaffected).

```
candidates = findSuperseded(current, isProtected)      // `current` = the post-phase-1 array
if (state.floor !== undefined) {
  for c of candidates:
    if (state.floor === 0 || (c.timestamp !== undefined && c.timestamp >= state.floor)) state.activated.add(key(c))
  state.floor = undefined
}
for c of candidates where state.activated.has(key(c)):
  if (current === input) current = current.slice()     // copy on first write, like the other phases
  current[c.resultIndex] = { ...current[c.resultIndex], content: [{ type: "text", text: STUB }] }
  pruned = true
```

`pruneMessages` returns the *input reference* with `pruned: false` when nothing changed, and `index.ts:1009` applies the result only under `if (result.pruned)` - so phase 1b must copy-on-write and set `pruned`, never mutate `messages` in place. When nothing activates, the no-op contract is preserved unchanged.

`floor === 0` (cold-cache event) activates every candidate regardless of timestamp, so sessions without result timestamps (pre-2026-08-12) still benefit at resume / model switch; positional floors simply never match them.

The stub is a single text block; `isError` stays `false`; `toolCallId`, `toolName`, `timestamp` are untouched so pi-ai's synthetic-result repair never fires. The assistant `toolCall` block (arguments) is untouched - it is small and shows which slice was read.

```
[Superseded: <path> was read again later in this conversation - see the newer read. Re-read the file if this earlier content is needed.]
```

The stub loop iterates **candidates** intersected with `activated`, never `activated` alone. A stale id in `activated` whose read has since become the newest for its path (its successor deleted or branched away) is therefore never stubbed.

Phase 3 (`applyChainCompressions`, `src/chain-range-prune.ts:186`) relocates `extractToolResultText(messages[i])` from the array phase 1b already rewrote, so a superseded read inside a compressed chain relocates as the stub instead of the verbatim body. No change to `chain-range-prune.ts`, `chain-detector.ts`, or `ChainCompressionEntry`.

## Data flow

Per turn, `pi.on("context")` (`index.ts` ~989) calls `pruneMessages(messages, indexer, cc, pe, protection, grace, diagnostics, supersede)`. Phases run 1 -> 1b -> 2 -> 3 -> 4.

Who sets `floor`. The rule: `floor` is the earliest prompt position the **next render will actually rewrite anyway**. Anything else would make the supersede stub the sole mid-prefix change - the deliberate cache miss decision (ii) forbids.

| Trigger | Where | Value |
|---|---|---|
| Batch flushed with outcome `flushed` or `skipped-deduped` (`indexer.addBatch` ran, so phase 1 will stub those results on the next render) | `flushPending`, after the result is known | earliest `resultTimestamp` across the flushed batches' `toolCalls` (for a fully deduped batch, across `dedupedPerBatch[i].toolCalls`, mirroring the frontier computation at `index.ts:328-340`) |
| Batch flushed with `skipped-oversized` / `skipped-trivial` | `flushPending` | **no floor from the batch's own calls** (they advance the frontier but are never indexed, so phase 1 will not rewrite them); dedup aliases registered in the pre-flush pass still count, because phase 1 stubs an alias regardless of its batch's outcome |
| Chain compressed | `flushPending` and `/pruner compact`, after `compressEligible` returns new entries | `entry.startUserTimestamp` of each new `ChainCompressionEntry` (`types.ts:481`) - the anchor user message precedes every message the chain drops, so it lower-bounds the rewrite |
| `session_start`, `session_tree`, `model_select`, `session_compact`, `thinking_level_select` | `session_start` / `session_tree` handlers exist; the other three are new one-line handlers | `0` (activate all) |

Protected calls are filtered out of `CapturedBatch.toolCalls` at `index.ts:874` and the batch itself is stamped `Date.now()` at `turn_end`, so neither the batch timestamp nor a protected result can be the floor source - only unprotected results phase 1 will stub. A turn containing only protected reads sets no floor; its superseded copies wait for a later rewrite at/before their position or a cold-cache event.

Why those five: cache is a per-model prefix. Resume (fresh process), branch switch (different history), model switch (different cache namespace), built-in compaction (whole history rewritten), and thinking-level change (part of the cache key on Anthropic) are all guaranteed-cold moments. Rewriting anything then is free.

Candidate timestamps and phase-1 floor sources are both `resultTimestampOf(ToolResultMessage.timestamp)`; the chain floor source is the anchor user message's timestamp, which is strictly earlier than every result the chain covers. All are session-clock milliseconds, so `>= floor` compares like with like.

## Invariant: the newest protected occurrence per path is never touched

Enforced by construction and covered by a dedicated test. Cross-checked against every phase:

- Phase 1: protected calls are never indexed (`index.ts:874`), and the render-time re-check at `pruner.ts:109` keeps an indexed record verbatim when `isProtected` is true now.
- Phase 1b: `findSuperseded` excludes the last occurrence per path; the stub loop only reaches candidates.
- Phase 2 error-purge: rewrites *arguments* of failed calls, never results.
- Phase 3 chain compression: protected ids are never dropped; they are relocated as `extractToolResultText` of the **post-1b** array, so the newest copy relocates verbatim and a superseded copy relocates as the stub. Phase order 1 -> 1b -> 2 -> 3 is load-bearing.
- Phase 4 orphan-sweep: only removes results whose `toolCall` is absent.

## Edge cases

| Case | Behavior |
|---|---|
| Newest read errored (`isError: true`, file removed) | Still wins (path-only identity). The older copy's stub points at re-reading; the model sees the error and knows why. Not special-cased. |
| Same path read twice in one batch (the 52 KB -> 5 KB pi-cohort pair, 4 s apart) | Activates on that flush **only if** some unprotected result phase 1 stubs sits at or before the older protected read (floor <= its timestamp). If the older read is the first result of the batch, the flush rewrite starts after it and the copy waits for a chain compression covering that turn or a cold-cache event. Accepted: honoring decision (ii) beats an early catch. |
| A < B < C, same path | Candidates are A and B; both activate when `floor` allows. C verbatim. Nothing recursive. |
| Same path in a protected and an unprotected call (`read` protected, `bash cat` not; or glob changed mid-session) | Only protected calls participate. Unprotected reads are neither candidates nor winners; they flow through normal summarization. |
| Protection config changed mid-session (`/pruner protected-paths`) | `isProtected` is evaluated live each turn. A path no longer protected has no candidates -> its stub is not applied and the raw result returns to the normal pipeline. Consistent with the existing "unprotected alias stays stubbed" rule direction: protection state is read live. |
| Newer read deleted or branched away (`session_tree`, message deletion) | Candidates are recomputed from the current array. The older read stops being a candidate and returns verbatim. Its key may linger in `activated` - harmless. |
| Newest call has no `ToolResultMessage` (turn aborted mid-call) | It does not participate; the previous read with a result is the winner and stays verbatim. |
| Result timestamps absent (session predates 2026-08-12) | Positional floors never activate; cold-cache events (`floor === 0`) still do. `activated` keys degrade to bare id. |
| `floor` set but no `context` event follows (flush at session end) | `floor` sits in memory; on restart `session_start` sets `0` anyway. |
| Protected call without a string `path` | Never a candidate, never a winner. Unchanged behavior. |
| Dedup alias whose original is a different path | Aliases are unprotected records; they never reach phase 1b. Unchanged. |

Diagnostics: none. Phase 1b cannot fail structurally (no id resolution, no range lookup).

## Out of scope

- Idle-time / TTL cache-expiry heuristics (provider-specific guesswork).
- `after_provider_response` `cacheRead` / `cacheWrite` as a trigger (reports the *previous* call's miss, i.e. the prefix is warm now - inverse of useful).
- `t<N>` refs and `context_tree_query` recovery for superseded reads (would require indexing protected calls - approach 2, rejected as non-surgical).
- Slice-aware identity (path + offset/limit).
- Canonicalizing relative vs absolute paths or resolving symlinks (unchanged from the predecessor spec).
- Any new config key or kill switch. Supersession is on whenever protection is: it stops exactly when no protected call remains (`protectedPaths: []` together with the default `protectedTools: []`); a read protected by tool name alone still participates.

## Testing

Bun, existing harness (`bun test src/`).

`src/supersede.test.ts` (pure):
- single protected read -> `[]`
- A < B same path -> `[A]`
- A < B < C -> `[A, B]`
- different `offset`/`limit` slices of one path -> older is a candidate
- two paths interleaved -> per-path winners, per-path candidates
- protected call without `path` -> ignored
- unprotected read of the same path -> neither candidate nor winner
- backslash path equals forward-slash path
- the last occurrence per path is never returned (assert over a shuffled fixture set)

`src/supersede.test.ts` also covers: newest call without a paired result -> previous read wins, nothing returned for it; missing result timestamps -> `timestamp: undefined`, pairing still by `block.id`; args read from `input` / `args` / `arguments` shapes alike.

`src/pruner.test.ts` additions:
- `supersede` param absent -> output identical to today
- nothing activated -> returns the input array reference with `pruned: false`
- one activation -> fresh array, `pruned: true`, input untouched
- `floor === undefined` -> candidate verbatim, `activated` empty
- `floor === 0` -> candidate stubbed, newest byte-for-byte verbatim
- `floor` above the candidate timestamp -> verbatim; then `floor` lowered below it -> stubbed; then `floor === undefined` -> still stubbed (sticky)
- superseded read inside a compressed chain -> `<protected-output>` body is the stub text, not the original
- stubbed result keeps `toolCallId` / `toolName` / `timestamp`; passes `expectNoOrphanToolResults`
- `isProtected` flips to false for the path -> stub not applied even though id is in `activated`
- newer read removed from the array -> older read verbatim even though key is in `activated`
- candidate with `timestamp: undefined` -> not activated by a positional floor; activated by `floor === 0`
- same `toolCallId` reused across two turns -> only the occurrence whose key is in `activated` is stubbed

Floor-write cadence (`flushPending`-level tests in the existing harness): mixed protected/unprotected flush sets `floor` to the first stubbed result's timestamp; `skipped-trivial` / `skipped-oversized` flush sets no floor; `skipped-deduped` flush sets floor from `dedupedPerBatch`; `compressEligible` returning entries sets floor to the minimum `startUserTimestamp`; a flush and a compression in one turn lower `floor` monotonically; a protected-only turn leaves `floor` undefined; each of the five events sets `floor = 0`.

`index.ts` wiring: smoke test per AGENTS.md - `pi -e ./index.ts --no-extensions -p "..."` against an isolated `$PI_CODING_AGENT_DIR`, reading a skill file twice in one run (expect both copies delivered while the cache is warm - decision ii), then resuming the session with a different `--model` (cold: `session_start` + model switch) and inspecting the delivered provider payload (`before_provider_request`) for exactly one verbatim copy plus one `[Superseded: ...]` stub. A switch *between* the reads cannot be the observed moment: only one read exists then, so there is nothing to activate.

## Documentation impact

Materiality bar: `pi-gauntlet/skills/brainstorming/reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `PRUNING.md` (protection section: "verbatim forever" -> "until a newer read of the same path", cadence rule and the five cold-cache events; phase list gains 1b), `README.md` (one sentence under `protectedPaths`), `CHANGELOG.md`
- Derived / memory docs invalidated: `AGENTS.md` project layout (`supersede.ts` row; `pruner.ts` composition line gains supersede); predecessor `doc/specs/2026-06-11-protected-paths.md` gets a partial-supersession banner scoped to the "Oversized protected read: stays verbatim in context forever" edge case
