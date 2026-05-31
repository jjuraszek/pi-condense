# Changelog

Format follows sibling pi packages (e.g. [`pi-superpowers`](https://github.com/jjuraszek/pi-superpowers/blob/main/CHANGELOG.md)):
one entry per `vX.Y.Z` tag, newest first, terse bullets, dated.

This fork is consumed via git tag pins (`git:github.com/jjuraszek/pi-context-prune@vX.Y.Z`).
The release helper at `.agents/skills/release/scripts/release.sh` cuts the tag and
automatically rewrites every `~/.pi/agent*/settings.json` that pins this repo.

## v1.0.0 — 2026-05-31

- **Removed three `pruneOn` modes**, leaving `agent-message` (default) and `on-demand`:
  - `every-turn` — debugging-only trigger with the worst prompt-cache churn.
  - `on-context-tag` — depended on the external `ttttmr/pi-context` extension and overlapped its `context_compact`.
  - `agentic-auto` — the scaffolded DCP-style model-driven `context_prune` tool was never wired to range compression (see `PRUNING.md § Future Work`).
- **Removed** the `context_prune` tool, the agentic-auto system prompt, the `<pruner-note>` unpruned-count reminder, and the `remindUnprunedCount` setting. Deleted `src/reminder.ts`, `src/context-prune-tool.ts`, `src/progress-text.ts`.
- **Migration:** none required. Configs pinned to a removed mode fall back to `agent-message` via `isPruneOn()`. A stale `remindUnprunedCount` key in `settings.json` is ignored.

## v0.11.1 — 2026-05-28

- **Release flow:** `release.sh` now rewrites every `~/.pi/agent*/settings.json` pin of `git:github.com/jjuraszek/pi-context-prune@<ref>` to the new `@vX.Y.Z` automatically after pushing the tag. Opt out with `--no-update-pins`. Aligns this fork's release workflow with sibling pi-* packages.
- **Docs:** `README.md` install section leads with the jjuraszek tag-pin (was upstream npm/sha references). `AGENTS.md` release blurb updated to reflect tag pins + automatic settings rewrite. `.agents/skills/release/SKILL.md` documents the new flow + flags. Adds this `CHANGELOG.md` for parity with sibling pi-* packages.

## v0.11.0 — 2026-05-28

- **Pre-flush pipeline:** content-hash dedup (re-reads of identical `(toolName, content)` pairs alias the original instead of going through the LLM), trivial-batch skip (`minBatchChars`), protected tools allowlist, stub-replace rather than delete. See `PRUNING.md § Pre-flush Pipeline & Safeguards`.
- **Settings:** moved to `<agent-dir>/settings.json#contextPrune` namespace (was a separate file). Honors `$PI_CODING_AGENT_DIR`.

## v0.10.0 — 2026-05-11

- `quietOversizedSkips` setting to suppress `skipped-oversized` notifications.
- Demote oversized-skip notification severity to info.
- Use short refs in pruned summaries (e.g. `t1`, `t2` rather than full toolCallIds) so the model can pass them back through `context_tree_query` more reliably.

## v0.9.x — 2026-05-05 → 2026-05-11

- `0.9.3`: spinner animation fix for `/pruner now`.
- `0.9.2`: replace footer progress with aboveEditor widget during `/pruner now`.
- `0.9.1`: allow `ESC` to cancel `context_prune` tool call.
- `0.9.0`: agentic-auto mode (`pruneOn: "agentic-auto"`), `context_prune` tool surfaced to the LLM, `remindUnprunedCount` setting.

## v0.8.x — 2026-05-04 → 2026-05-05

- `0.8.1`: bug fixes around session-start index rebuild.
- `0.8.0`: `agent-message` trigger mode + batching, footer status widget.

## v0.7.0 — 2026-05-04

- `on-context-tag` trigger mode (integrates with `pi-context` `context_checkpoint`).

## v0.6.x — 2026-05-02

- Tree browser (`/pruner tree`) + summary overlay (`Ctrl-O`).
- `dedupByContentHash` cross-flush dedup.

## v0.5.0 — 2026-05-01

- Cumulative summarizer token/cost stats (`/pruner stats`).

## v0.4.0 — 2026-05-01

- Configurable summarizer model + thinking level (`/pruner model`, `/pruner thinking`).

## Earlier (v0.1.x – v0.3.x)

Initial extension scaffolding, `context_tree_query` tool, base summarization loop, session-JSONL index persistence. See `git log` for granular history.
