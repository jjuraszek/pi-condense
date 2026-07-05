# Path-based protection: `protectedPaths`

GitHub issue: [#1](https://github.com/jjuraszek/pi-context-prune/issues/1)

## Problem

The pruner treats all `read` results as data, but skill bodies are standing instructions. Summarizing them is categorically lossy: the model later executes the summary, not the skill.

Observed failure (real session): an SDD run read `subagent-driven-development/SKILL.md`; the pruner replaced it ~6 turns later with a 2-sentence summary that omitted the closing-loop step, and the session marked verify complete without running the gate. Verified against the session JSONL: all 4 SKILL.md reads (`writing-plans`, `subagent-driven-development`, `finishing-a-development-branch`, `linear`) were indexed and summarized. All 4 went through `read` with a `path` argument.

`protectedTools` cannot fix this: it is tool-name based, and protecting all of `read` defeats the pruner. This bites hardest with pi-gauntlet, where skill files carry multi-step workflow gates.

## Decision

New config field `protectedPaths: string[]`, default `["**/skills/**/*.md"]`. A tool call whose `args.path` matches any pattern is protected with **identical semantics to `protectedTools`**: never enters a batch, never indexed, never spilled, raw output stays verbatim in context; inside compressed chains it is relocated verbatim as `<protected-output>`.

### Defaults and matching

| Aspect | Decision |
|---|---|
| Default | `["**/skills/**/*.md"]` — covers `SKILL.md` AND sibling reference files under any `skills/` dir (superpowers `.../skills/<name>/*.md`, in-repo `.agents/skills/...`, `~/.agents/skills/...`) |
| Matched argument | `args.path` only (string). pi's `read` and `navigator_slice` use `path`. Non-string or missing `path` → not protected. |
| Glob contract | Hand-rolled glob→regex, no new runtime dependency. Full-path match against the raw arg with `\` normalized to `/`. `*` and `?` match within a path segment (no `/`); `**` crosses segments; `**/` also matches zero directories (so `**/SKILL.md` matches a bare relative `SKILL.md`). All other characters are regex-escaped literals. Case-sensitive. |
| Kill switch | `"contextPrune": { "protectedPaths": [] }` in settings.json. `normalize()` spreads `existing` over `DEFAULT_CONFIG`, so an explicit `[]` wins. |
| Command | `/pruner protected-paths [patterns]` mirroring `protected-tools` (interactive prompt; `none` clears). Also shown in the `/pruner settings` overlay. |

**Behavior change on upgrade:** unlike `protectedTools` (default `[]`), the non-empty default changes behavior for existing users — that is the point of the issue. Risk: an unrelated large docs tree under a `skills/` dir never prunes; mitigated by the kill switch.

## Implementation

### New module: `src/protected.ts` (pure)

```ts
isProtected(toolName: string, args: unknown, config): boolean
```

True iff `toolName ∈ protectedTools` OR `args.path` is a string matching any `protectedPaths` glob. Compiled patterns cached in a module-level `Map<string, RegExp>` keyed by pattern string (config edits mid-session pick up new patterns without invalidation logic).

### Wiring — same 3 surfaces as `protectedTools`

| Surface | Today | Change |
|---|---|---|
| Live capture filter (`index.ts` turn_end) | name-set check | call `isProtected(name, args, config)` with the captured call's normalized args; protected calls never enter the batch (also exempts them from eager spill) |
| `captureUnindexedBatchesFromSession` (`src/batch-capture.ts`) | `excludeToolNames: Set<string>` | generalize to a predicate param `(toolName, args) => boolean`; call sites extract args from the raw toolCall block as `tc.input ?? tc.arguments` |
| `detectChains` (`src/chain-detector.ts`) | `protectedSet.has(name)` on assistant toolCall blocks and toolResult fallback | assistant block check uses the predicate with `block.input ?? block.arguments`. The toolResult fallback stays **name-only**: results carry no args, and the assistant block always precedes its result, so no protection is lost. |

### Repairing already-summarized reads (render-time re-check)

Stub replacement is applied in-flight by `pruneMessages` on every turn; the raw toolResult bodies still live in the session JSONL, and `ToolCallRecord.args` is already persisted in `context-prune-index` entries and rebuilt on `session_start`. So `pruneMessages` adds one condition to the stub-replace path: if the record's `args` now satisfies `isProtected`, skip stubbing and leave the raw result verbatim. This repairs existing sessions (including the motivating one) with no schema change and no migration.

**Declared limitation:** records inside already-compressed chains (`context-prune-chain` entries) are NOT repaired — the chain's `protectedToolCallIds` set is fixed at compression time. Forward-only there.

### Config plumbing

- `src/types.ts`: add `protectedPaths: string[]` to `ContextPruneConfig`; `DEFAULT_CONFIG.protectedPaths = ["**/skills/**/*.md"]`.
- `src/config.ts`: no explicit `normalize()` clause (follows `protectedTools` precedent — spread handles it).
- `src/commands.ts`: `protected-paths` subcommand + config-overlay row, cloned from `protectedTools` handling.

### Out of scope

- `file_path`/other arg names (pi tools use `path`; revisit if a real tool surfaces).
- Dedup, error-purge, thinking-strip — untouched.
- Protecting skill content injected via user/system messages — the pruner never touches those.
- Path resolution/normalization: match against the raw `path` string as the model sent it (absolute or relative). Patterns anchored with `**/` make this robust.

## Edge cases

- Oversized protected read: stays verbatim in context forever, never spilled. By design — that is what "protected" means.
- Pattern matching a non-read tool's `path` arg (e.g. a write target): protected. Harmless — write results are tiny.
- Invalid glob: hand-rolled converter cannot throw; every pattern compiles to some regex.

## Testing

- Unit tests: glob matcher (`**`, `*`, `?`, zero-dir `**/`, segment-locality of `*`, regex-char escaping, `\` normalization, no-match cases) and `isProtected` (name OR path, non-string path, empty config).
- Unit test: chain compression with a path-protected call — its output relocates verbatim as `<protected-output>` into the synthetic body.
- Unit test: render-time re-check — a record summarized under old config is left unstubbed once its path matches `protectedPaths`.
- Smoke test per AGENTS.md: isolated `$PI_CODING_AGENT_DIR`, read a `skills/**/*.md` file plus enough unprotected calls to clear `minBatchChars`, force a flush (`/pruner now`), then assert (a) a `context-prune-index` entry exists for the batch, (b) the protected toolCallId is absent from it, (c) the raw result is intact in the next-turn context. Asserting (a) guards against the false-pass where the whole batch was skipped as trivial.
- Regression: existing `protectedTools` tests stay green.

## Documentation updates

- `README.md`: `protectedPaths` row in the config table (next to `protectedTools`), default shown in the example settings block, `/pruner protected-paths` in the command table.
- `PRUNING.md`: extend "Protected tools" section to "Protected tools & paths" — predicate semantics, capture-time filtering, chain-compression relocation contract (§ existing protected-output rationale applies unchanged).
- `AGENTS.md`: no structural change needed; `context-prune-chain` row already documents `protectedToolCallIds` — reword to say ids can be protected by name or path.

Keep doc tone dense and human-readable per repo conventions.
