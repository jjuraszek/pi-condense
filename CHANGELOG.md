# Changelog

Keep-a-Changelog style (`## [X.Y.Z] - <date>`, newest first), matching sibling
pi packages (e.g. [`pi-cohort`](https://github.com/jjuraszek/pi-cohort/blob/main/CHANGELOG.md)).

Published to npm as [`pi-condense`](https://www.npmjs.com/package/pi-condense) (`pi install npm:pi-condense`).
Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which runs the tests and
publishes via OIDC trusted publishing. See `.agents/skills/release/SKILL.md`.

## [Unreleased]

## [2.1.1] - 2026-07-04

- **`release.yml` posts GitHub Release notes.** A new `release-notes` job (`needs: publish`, `contents: write`) extracts the CHANGELOG section matching the pushed tag with `awk` (skipping `## [Unreleased]`) and publishes it as the GitHub Release body via `gh release create` (falling back to `gh release edit`). No LLM or API key; only `github.token`.

## [2.1.0] - 2026-07-04

- **Per-bullet recovery refs in prune summaries** (closes #2). Each per-tool block in a summary now carries its own inline `` `tN` `` ref, so the model recovers a specific tool's raw output in one hop instead of guessing which flat-footer ref maps to which bullet. The serializer labels each tool block `[[N:toolname]]` (`src/batch-capture.ts`), the summarizer prompt tells the model to copy that label onto its first bullet (`src/summarizer.ts`), and `substituteInlineRefs` (`src/summary-refs.ts`) validates the echoed tool name against the tool at position N before rewriting to `` `tN` ``. The flat footer is retained unchanged as the always-correct fallback. Deterministic number->shortId map over the shared post-dedup `batch.toolCalls` order; the tool-name tag downgrades a confident wrong-ref (skip-induced renumber) to footer-only, and mismatched / out-of-range / wrapped / mid-line labels are stripped (fence-aware leak guard) so no raw `[[N:name]]` token ever leaks into context. No new tool, config key, or index.

## [2.0.1] - 2026-07-03

- **Prune summaries are now hidden from Pi's main window** (`display: false` at both injection sites in `index.ts`). They stay in LLM context and session history (recoverable via `context_tree_query`) but no longer print the full markdown block into the TUI. Mirrors upstream `pi-context-prune` `2fd6127`.
- **Sharpened the summarizer prompt** (`src/summarizer.ts`): the key-outcome bullet now requires copying file paths, identifiers, signatures, and error strings *verbatim* (never reworded), and the summarizer skips tool calls that succeeded with nothing reusable to record. Scoped to short tokens - values/full output stay summarized, so the ~8x median compression and the oversized guard are unaffected.
- **`context_tree_query` description now shows a literal call example** (`{ toolCallIds: ["t12", "t3"] }`) and consolidates the two near-duplicate parameter descriptions into one that marks the field required. Reduces the empty-first-call retry seen in real sessions. No schema or behavior change.

## [2.0.0] - 2026-07-02

- **Renamed the package `pi-context-prune` -> `pi-condense`** and switched distribution from git-tag pins to npm. Install with `pi install npm:pi-condense` (was `git:github.com/jjuraszek/pi-context-prune@vX.Y.Z`). Migrate pinned `settings.json` entries; `release.sh sync-presets` reports stale pins.
- **Added npm release machinery:** `.github/workflows/release.yml` (tag-triggered, OIDC + provenance, `tag == package.json` gate) and `test.yml` (bun, Ubuntu + Windows matrix). Ported `release.sh` to the shared sibling skeleton (`propose` / `patch|minor|major` / `current` / `verify` / `sync-presets`), replacing the old tag-pin `release.mjs`.
- **Added** `LICENSE` (MIT), `files` allowlist, `engines`, and `author` to `package.json`; removed dead `pi.skills` / `pi.prompts` manifest entries (those directories never existed).
- **Renamed** the cost-event producer id `EXTERNAL_COST_SOURCE` `"pi-context-prune"` -> `"pi-condense"`. Aggregators keyed on the old `source` string see it as a new producer.

## [1.0.0] - 2026-05-31

- **Removed three `pruneOn` modes**, leaving `agent-message` (default) and `on-demand`:
  - `every-turn` - debugging-only trigger with the worst prompt-cache churn.
  - `on-context-tag` - depended on the external `ttttmr/pi-context` extension and overlapped its `context_compact`.
  - `agentic-auto` - the scaffolded DCP-style model-driven `context_prune` tool was never wired to range compression (see `PRUNING.md`, Future Work).
- **Removed** the `context_prune` tool, the agentic-auto system prompt, the `<pruner-note>` unpruned-count reminder, and the `remindUnprunedCount` setting. Deleted `src/reminder.ts`, `src/context-prune-tool.ts`, `src/progress-text.ts`.
- **Migration:** none required. Configs pinned to a removed mode fall back to `agent-message` via `isPruneOn()`. A stale `remindUnprunedCount` key in `settings.json` is ignored.

## [0.11.1] - 2026-05-28

- **Release flow:** `release.sh` now rewrites every `~/.pi/agent*/settings.json` pin of `git:github.com/jjuraszek/pi-context-prune@<ref>` to the new `@vX.Y.Z` automatically after pushing the tag. Opt out with `--no-update-pins`. Aligns this fork's release workflow with sibling pi-* packages.
- **Docs:** `README.md` install section leads with the jjuraszek tag-pin (was upstream npm/sha references). `AGENTS.md` release blurb updated to reflect tag pins + automatic settings rewrite. `.agents/skills/release/SKILL.md` documents the new flow + flags. Adds this `CHANGELOG.md` for parity with sibling pi-* packages.

## [0.11.0] - 2026-05-28

- **Pre-flush pipeline:** content-hash dedup (re-reads of identical `(toolName, content)` pairs alias the original instead of going through the LLM), trivial-batch skip (`minBatchChars`), protected tools allowlist, stub-replace rather than delete. See `PRUNING.md`, Pre-flush Pipeline & Safeguards.
- **Settings:** moved to `<agent-dir>/settings.json#contextPrune` namespace (was a separate file). Honors `$PI_CODING_AGENT_DIR`.

## [0.10.0] - 2026-05-11

- `quietOversizedSkips` setting to suppress `skipped-oversized` notifications.
- Demote oversized-skip notification severity to info.
- Use short refs in pruned summaries (e.g. `t1`, `t2` rather than full toolCallIds) so the model can pass them back through `context_tree_query` more reliably.

## [0.9.x] - 2026-05-05 to 2026-05-11

- `0.9.3`: spinner animation fix for `/pruner now`.
- `0.9.2`: replace footer progress with aboveEditor widget during `/pruner now`.
- `0.9.1`: allow `ESC` to cancel `context_prune` tool call.
- `0.9.0`: agentic-auto mode (`pruneOn: "agentic-auto"`), `context_prune` tool surfaced to the LLM, `remindUnprunedCount` setting.

## [0.8.x] - 2026-05-04 to 2026-05-05

- `0.8.1`: bug fixes around session-start index rebuild.
- `0.8.0`: `agent-message` trigger mode + batching, footer status widget.

## [0.7.0] - 2026-05-04

- `on-context-tag` trigger mode (integrates with `pi-context` `context_checkpoint`).

## [0.6.x] - 2026-05-02

- Tree browser (`/pruner tree`) + summary overlay (`Ctrl-O`).
- `dedupByContentHash` cross-flush dedup.

## [0.5.0] - 2026-05-01

- Cumulative summarizer token/cost stats (`/pruner stats`).

## [0.4.0] - 2026-05-01

- Configurable summarizer model + thinking level (`/pruner model`, `/pruner thinking`).

## Earlier (v0.1.x - v0.3.x)

Initial extension scaffolding, `context_tree_query` tool, base summarization loop, session-JSONL index persistence. See `git log` for granular history.
