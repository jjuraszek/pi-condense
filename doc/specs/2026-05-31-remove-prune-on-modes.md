# Remove underdeveloped `pruneOn` modes (→ v1.0.0)

- **Date:** 2026-05-31
- **Branch / worktree:** `remove-prune-on-modes` (`.worktrees/remove-prune-on-modes`)
- **Status:** spec — awaiting review
- **Release target:** `v1.0.0` (major)

## Summary

Drop three `pruneOn` trigger modes — `every-turn`, `on-context-tag`, `agentic-auto` — and every artifact that exists only to serve them. Keep the two load-bearing modes: `agent-message` (default) and `on-demand`. Delete the dead `remindUnprunedCount` config field. Cut a `v1.0.0` release marking the stable, two-mode core after removing experimental/underdeveloped surface.

The removed surface is either experimental-but-unwired (`agentic-auto`'s `context_prune` tool was scaffolded, not productionized), coupled to an external extension we don't control (`on-context-tag` soft-depends on `ttttmr/pi-context`), or a cache-hostile debugging aid (`every-turn`).

## Motivation & recorded assessment

**Local setup impact: none.** Verified across all three agent profiles:

| Profile | `contextPrune.pruneOn` | Affected? |
|---|---|---|
| `~/.pi/agent` | (no `contextPrune` key) | no |
| `~/.pi/agent.anthropic` | `agent-message` | no |
| `~/.pi/agent.bedrock` | `agent-message` | no |

Both `.anthropic` and `.bedrock` also carry `remindUnprunedCount: true`, which is already a no-op for them (only ever honored in `agentic-auto`).

**Graceful fallback already exists.** `isPruneOn()` in `src/config.ts` validates the persisted `pruneOn` against `PRUNE_ON_MODES`; an unknown/removed value falls back to `DEFAULT_CONFIG.pruneOn` (`agent-message`). So even a config pinned to a removed mode degrades silently rather than erroring.

**pi-context coupling is soft, and overlaps this extension.** There is no package/peer dependency on `ttttmr/pi-context` (`package.json` has zero deps on it). The only coupling is runtime: the `tool_execution_end` handler listens for the `context_tag` / `context_checkpoint` tool names. If pi-context isn't installed, `on-context-tag` silently never fires. Separately, pi-context's own `context_compact` tool performs LLM-driven compaction of a path into a handoff summary — partial functional overlap with this extension's rolling tool-batch summarization (different trigger models: checkpoint/time-travel vs. automatic). Removing `on-context-tag` drops a redundant trigger wired to an uncontrolled extension.

## Scope

| Mode | Disposition | Rationale |
|---|---|---|
| `agent-message` | **keep (default)** | Flushes on the agent's next text response; prefix-cache friendly. |
| `on-demand` | **keep** | Manual flush via `/pruner now`. |
| `every-turn` | **remove** | Debugging-only; worst prompt-cache churn. |
| `on-context-tag` | **remove** | Soft-depends on external `pi-context`; redundant with its `context_compact`. |
| `agentic-auto` | **remove** | Model-driven `context_prune` tool was scaffolded, never productionized. |

End state: `export type PruneOn = "on-demand" | "agent-message";`

## Removal inventory (the contract)

### Files deleted

| File | Why it's now dead |
|---|---|
| `src/reminder.ts` | `annotateWithUnprunedCount` / `countUnprunedToolCalls` feed the `<pruner-note>`, only emitted in `agentic-auto`. |
| `src/context-prune-tool.ts` | Registers the `context_prune` tool, only activated in `agentic-auto`. |
| `src/progress-text.ts` | `pruneProgressText` is imported only by `context-prune-tool.ts`. (`formatCharProgress` lives in `src/stats.ts` and stays — used by the `/pruner now` widget.) |

### `index.ts`

- Remove imports: `annotateWithUnprunedCount, countUnprunedToolCalls` (`./src/reminder.js`); `registerContextPruneTool` (`./src/context-prune-tool.js`); `CONTEXT_PRUNE_TOOL_NAME`, `AGENTIC_AUTO_SYSTEM_PROMPT` (`./src/types.js`).
- Fix initial `currentConfig` value: `{ ...DEFAULT_CONFIG, pruneOn: "every-turn" }` → `{ ...DEFAULT_CONFIG }` (the `every-turn` seed is a pre-`session_start` placeholder and references a removed mode).
- Delete the `syncToolActivation` helper and all calls to it (also its `session_start` call).
- Delete the `tool_execution_end` handler in full (`on-context-tag`).
- Delete the `before_agent_start` handler in full (`agentic-auto` system prompt).
- Delete the `registerContextPruneTool(...)` registration call.
- In the `context` handler, delete the `agentic-auto` `<pruner-note>` block (the `countUnprunedToolCalls` / `annotateWithUnprunedCount` path).
- In `turn_end`: delete the `if (pruneOn === "every-turn") { flush }` branch; drop the `pruneOn !== "every-turn"` clause from the budget-flush guard (now unconditional); collapse the trigger-label switch to the two remaining modes:
  ```ts
  const trigger = currentConfig.value.pruneOn === "agent-message"
    ? "agent's next text response"
    : "/pruner now";
  ```
- Drop `CONTEXT_PRUNE_TOOL_NAME` from the two capture-exclusion sets (the `turn_end` protected-tool `Set` and the `capturePendingBatches` exclude list); both reduce to `currentConfig.value.protectedTools`.
- Drop the `syncToolActivation` argument from the `registerCommands(...)` call.

### `types.ts`

- `PruneOn`: narrow to `"on-demand" | "agent-message"`; update its doc comment.
- `PRUNE_ON_MODES`: keep only `agent-message` (listed first, the default) and `on-demand`.
- Delete `CONTEXT_PRUNE_TOOL_NAME` and `AGENTIC_AUTO_SYSTEM_PROMPT` consts. (`PROGRESS_WIDGET_ID` stays.)
- Delete `remindUnprunedCount` from the `ContextPruneConfig` interface and from `DEFAULT_CONFIG`.
- Update the `protectedTools` doc comment that references the `agentic-auto` `<pruner-note>`.

### `config.ts`

- Delete the `remindUnprunedCount` normalization block in `normalize()`.
- No other change: `isPruneOn` derives from `PRUNE_ON_MODES`, so trimming that array narrows validation automatically.
- **No migration code added** (per decision below).

### `commands.ts`

- `PRUNE_MODE_GUIDANCE`: remove the `every-turn` / `on-context-tag` / `agentic-auto` entries.
- Delete `remindUnprunedCountDescription` and its uses.
- Settings overlay: remove the `remindUnprunedCount` `SettingItem`, its `onChange` branch, and the cross-update of its description in the `pruneOn` `onChange` branch.
- Remove the `syncToolActivation` parameter from `registerCommands` and every call site inside it.
- `/pruner status`: drop the `remind: … (agentic-auto only)` line.
- `HELP_TEXT`: remove the `prune-on every-turn` / `on-context-tag` / `agentic-auto` lines, the `remindUnprunedCount` note, the `protectedTools` `<pruner-note>` sentence, and the removed-mode guidance bullets. In the `Related:` block, drop the `pi-context` link line (orphaned by removing `on-context-tag`); keep the `Related:` header and the Anthropic prompt-caching bullet.
- Update the comment that parses a selector label (example currently `"every-turn — Every turn"`) to use a surviving mode.

## Config & migration behavior

- **Persisted removed modes** (`pruneOn: "every-turn" | "on-context-tag" | "agentic-auto"`): silently fall back to `agent-message` via `isPruneOn()`. No crash, no warning.
- **Dead `remindUnprunedCount` key:** no strip/migration code is added. Because `normalize()` does `{ ...DEFAULT_CONFIG, ...existing }`, a stale `remindUnprunedCount` in an existing file is carried through into the runtime config object and re-persisted on the next settings write — until the key is physically removed from the file. It is therefore **hand-cleaned from the two settings files after release** (see Release plan). Once removed from the file it cannot reappear: nothing writes it back (the field is gone from the interface, `DEFAULT_CONFIG`, and the settings UI).
- **Rationale for no migration code:** the user explicitly chose hand-clean-after-release over adding a one-line strip. Keeps the change pure-deletion; the release script rewrites the version pin in those same files, so tidying the dead key afterward avoids racing it.

## Documentation changes

| Doc | Edits |
|---|---|
| `README.md` | Mode table: drop the three removed rows, keep `agent-message` + `on-demand`. Remove `remindUnprunedCount` from the example config block and the settings table. Update the `autoBudgetThreshold` note that references `every-turn`. Remove the `context_prune` tool description. Remove the pi-context "Related extensions" link tied to `on-context-tag` (keep unrelated pi-cache-graph tuning references). |
| `PRUNING.md` | **Reframe** the "per-turn pruning trap" ASCII section as *naive per-turn pruning* (a hypothetical bad approach that motivates the batched `agent-message` default), not a selectable mode. Remove the three modes from the comparison table and the trigger decision-tree. Fix the `protectedTools` `<pruner-note>` reference, the `remindUnprunedCount` bullet, the `autoBudgetThreshold`/`every-turn` note, the "scaffolded but not wired" `agentic-auto` compress-tool note, the cache-performance mode mentions, and the pi-context link. |
| `AGENTS.md` | Project-layout block: drop `context-prune-tool` from the `(other src/*.ts)` comment. |
| `CHANGELOG.md` | New top entry for `v1.0.0` (terse bullets, newest-first, dated), recording the mode/field removals and the 1.0 framing. |
| `src/batch-capture.ts` | Update the comment (~line 128) that references `agentic-auto`; the trim-to-ready-tool-calls behavior stays (valid for any flush). |

## Release plan (`v1.0.0`)

Final phase, in order:

1. **Typecheck** — the AGENTS.md one-liner (`bun x tsc --noEmit …`). Must pass.
2. **Pre-release smoke (release gate)** — end-to-end dummy session against an isolated `$PI_CODING_AGENT_DIR`: `pi -e ./index.ts --no-extensions -p "…"`. Confirm the flush path still writes the expected `context-prune-*` session entries and that startup logs no error about missing modes/symbols. Inspect with:
   ```bash
   jq -r 'select(.type=="custom" or .type=="custom_message") | .customType' session.jsonl | sort | uniq -c
   ```
3. **CHANGELOG entry + commit** on the worktree branch.
4. **Release** via the `release` skill (`release.sh`): bump `package.json` to `1.0.0`, create + push tag `v1.0.0`, auto-rewrite the `git:…@vX.Y.Z` pins in `~/.pi/agent*/settings.json`.
5. **Clean config** — hand-remove the dead `remindUnprunedCount` key from `~/.pi/agent.anthropic/settings.json` and `~/.pi/agent.bedrock/settings.json`.
6. **Final sanity** — one more end-to-end dummy session, now against the real pinned `v1.0.0` + cleaned config, confirming `context-prune-*` entries are written and the session is error-free.

## Testing / verification approach

- **Baseline (captured now):** `bun test src/` → 130 pass, 0 fail. No test references any removed symbol, mode, or deleted file, so the suite stays green by construction.
- **Typecheck** gates the release (step 1 above); catches any missed import or symbol reference.
- **End-to-end dummy session** is the integration gate (steps 2 and 6): pure-deletion changes that typecheck can still break runtime wiring (e.g. a removed handler another path depended on), so a live flush is exercised before and after release.
- No new unit tests: this is removal of code paths that have no dedicated tests; the surviving `agent-message` / `on-demand` paths are already covered by `pruner.test.ts` and friends.

## Edge cases & risks

- **Stale `remindUnprunedCount` re-persisted before hand-clean.** Expected and benign — nothing reads it. Resolved permanently by step 5.
- **A user (not in scope here) on a removed mode.** Falls back to `agent-message`; acceptable for a 1.0 that drops the modes.
- **`PRUNE_ON_MODES` ordering.** Cosmetic (drives only the settings selector + a label-parse). Spec lists `agent-message` first as the default; the label-parse splits on `—` and is order-independent.
- **Broken release tag if step 2 is skipped.** Mitigated by making the pre-release smoke a hard gate before `release.sh`.

## Out of scope

- Touching the surviving `agent-message` / `on-demand` flush logic, batching, dedup, chain compression, or thinking-strip.
- Any change to `package.json` beyond the version bump.
- Adding migration/normalization code for the dead key (explicitly declined).
- Changing pi-context or interacting with it in any way.

## Open questions

- **Changelog wording for the 1.0 framing.** The major bump was justified as "DCP parity + remove underdeveloped parts." This spec records the substance neutrally ("stable two-mode core after removing experimental surface"). If the literal "DCP parity" phrasing should appear verbatim in the `CHANGELOG`/release notes, say so and name what "DCP" refers to; otherwise the neutral phrasing ships.
