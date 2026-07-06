# pi-condense

Pi extension. Captures completed tool-call batches, summarizes them with an LLM, replaces raw tool results with short stubs in future context, and exposes `context_tree_query` to recover originals on demand. Targeted at long agent sessions where raw tool outputs dominate the prompt.

<!-- agents-core:begin v1 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Communication Style

Same rules as the parent `~/.pi/agent*/AGENTS.md`. Applies to chat, commit messages, PR/issue comments, code review, and any artifact authored in this repo.

- **Human, terse, but sharp and precise.** Applies everywhere: interactive session, issue/PR comments, `.md` files. Terse is not vague - keep it exact.
- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **Show an example when it clarifies a complex point** - a small before/after or a concrete ref beats a paragraph. Examples disambiguate, they don't pad.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts (issues, PRs, chat).
- **Prefer ASCII.** `-` not em/en-dashes, `...` not the ellipsis glyph, straight quotes. Non-ASCII only for a justified visual mark.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `CHANGELOG.md`, skill bodies, agent personas, spec docs, code comments where the *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **Docs are a contract.** Dense, current, no preamble. If a sentence doesn't help a future reader act, cut it - this applies to documentation as much as code.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers - validate at the boundary once.
- **Delete dead code, don't comment it out.** Branch from the deletion commit if reversibility matters.
- **Comments only when the *why* is non-obvious.** No docstrings on self-evident params/returns. No banner/separator comments. Don't reference the current task or PR - that belongs in the commit message.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.

## Ticket convention

Every GitHub issue follows **Context -> Problem -> Idea (how to address) -> Acceptance Criteria**, then the idea is **roasted by 2 subagents and the consolidated roast is posted as a comment** before the issue is ready. A roast that kills or shrinks the idea is a success - file only what survives.

## Ground Truth Before Reasoning

Never guess Pi's API, message shapes, config, or values - read the source; the source wins; if it is missing, say so and ask, don't fabricate. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner` - treat its shipped `.d.ts` as API truth. Repo-specific source pointers, if any, follow.

<!-- agents-core:end v1 -->

## Ground truth pointers

Repo-specific sources (the principle is in the shared core above); field names matter and the type files are authoritative:

- **Pi event/extension API:** `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ExtensionAPI`, `ExtensionContext`, every `pi.on(...)` event payload, `appendEntry`, `setActiveTools`, `setWidget`, `sendMessage`.
- **LLM message shapes:** `node_modules/@earendil-works/pi-ai/dist/types.d.ts` — `AssistantMessage`, `ToolResultMessage`, `ToolCall`, `UsageInfo`. Field names matter (`id` vs `toolCallId`, `arguments` vs `input`); the type files are authoritative.
- **pi-ai's auto-repair behavior:** `node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js` — `insertSyntheticToolResults` injects `{ isError: true, "No result provided" }` for orphaned tool calls. Knowing this is the reason `src/pruner.ts` returns stub messages instead of deleting them.
- **Session entry layout:** `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` — `getBranch()` returns `SessionEntry[]` (wrapped messages), not `AgentMessage[]`.

## Routing

| Want to … | Read |
|---|---|
| Understand what pruning does, why, the algorithm, design rationale, references | [`PRUNING.md`](PRUNING.md) |
| Install, configure, list of `/pruner` commands and settings | [`README.md`](README.md) |
| Implementation: hook a Pi event, change the indexer, touch the summarizer | open the matching `src/*.ts` file directly |
| Run a release | `.agents/skills/release/SKILL.md` |
| Brainstorm / plan a multi-step change | superpowers `brainstorming` then `writing-plans` skills; specs land in `doc/specs/`, plans in `doc/plans/` (ephemeral) |
| File an issue / ticket | Ticket convention above (Context -> Problem -> Idea -> ACs + 2-subagent roast comment) |
| Override a pi-gauntlet skill for this repo | [`.pi/gauntlet-overrides.md`](.pi/gauntlet-overrides.md) |
| Historical context for a past change | `doc/specs/*.md` (newest first) |
| Change the shared AGENTS core (style / discipline / ticket / ground-truth) | edit [`AGENTS.core.md`](AGENTS.core.md), run `node scripts/check-agents-core.mjs --fix`, copy both files to sibling repos |

## Workflow

- **Multi-step work uses the superpowers `brainstorming` → `writing-plans` skills.** Specs live in `doc/specs/` (`YYYY-MM-DD-<topic>.md`); plans in the sibling `doc/plans/`. Keep the checklist in sync with reality.
- **Plans are ephemeral; specs are durable.** `doc/plans/` lives only on the feature branch - `git rm` it before finishing the branch so it never lands on `main` (it stays in branch history). Only `doc/specs/` reaches `main`. Codified in [`.pi/gauntlet-overrides.md`](.pi/gauntlet-overrides.md); most work here is gauntlet-driven.
- **Isolate feature work in a git worktree.** Worktrees default to `.worktrees/<branch>` at the repo root (already gitignored); use the superpowers `using-git-worktrees` skill. The spec is the first commit on the branch.
- **Releases use the `release` skill.** Published to **npm** as `pi-condense` (users install `npm:pi-condense`). Tag-driven and CI-executed: `release.sh` bumps the version, commits, and pushes a `vX.Y.Z` tag; pushing the tag triggers `.github/workflows/release.yml`, which gates on `tag == package.json`, runs `bun test src/`, and publishes via OIDC trusted publishing + provenance. **Never run `npm publish` by hand.** The `release.sh` config header is the only per-repo block; keep it in sync with the sibling `pi-cohort` / `pi-gauntlet` copies. See `.agents/skills/release/SKILL.md` for the full flow + `--dry-run` / `sync-presets` flags.
- **Smoke-test new behavior end-to-end** with `pi -e ./index.ts --no-extensions -p "..."` against an isolated `$PI_CODING_AGENT_DIR`. Inspect session JSONL entries (`jq -r 'select(.type == "custom" or .type == "custom_message") | .customType' session.jsonl | sort | uniq -c`) to verify the expected `context-prune-*` entries are written.
- **Typecheck before committing.** No package script is wired; run `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove is fine — don't commit it).

## Project Layout

```
index.ts                           # extension entry point, wires all events
src/
  chain-detector.ts                # pure: AgentMessage[] → ChainRange[] (detects closed chains)
  chain-range-prune.ts             # pure: applies ChainCompressionEntry[] to messages in-flight
  chain-compressor.ts              # orchestrator: rolling-window eligibility, persistence, range-summary fusion (async)
  block-refs.ts                    # monotonic b<N> issuer + rebuild from session
  indexer.ts                       # tool-call index + chain registry + summary body tracking
  nested-placeholders.ts           # pure: {bN} substitution in chain summary text
  error-purge.ts                   # pure: replace failed toolCall arg bodies with stubs after cooldown
  thinking-strip.ts                # pure: keep thinking on last K assistant turns, strip older (main-loop)
  pruner.ts                        # pruneMessages: composes stub-replace → error-purge → chain-range-prune → thinking-strip
  commands.ts                      # /pruner subcommands, settings overlay, status widget
  summarizer.ts                    # LLM summarization calls (per-batch + range fusion via shared runSummarization)
  summarizer-fallback.ts           # pure: sticky in-memory FallbackController for summarizer-model outages (transient-only, 10-min re-probe)
  stats.ts                         # StatsAccumulator + formatting helpers
  types.ts                         # all shared types, constants, DEFAULT_CONFIG
  (other src/*.ts)                 # frontier, config, dedup, tree-browser
.agents/skills/                    # in-repo skills (release)
.pi/gauntlet-overrides.md          # per-repo pi-gauntlet skill overrides (plan retention, ticket convention)
doc/specs/                         # durable specs (superpowers brainstorming); reach main
doc/plans/                         # ephemeral plans (superpowers writing-plans); git rm before ship, never on main
.worktrees/                        # git worktrees for feature branches (gitignored)
PRUNING.md                         # algorithm + design rationale + research refs
README.md                          # install + config + command reference
package.json                       # pi-extension manifest (declares `./index.ts`)
```

Custom session entry types written by the extension (NOT in LLM context unless noted):

| customType | Written by | Purpose |
|---|---|---|
| `context-prune-index` | `indexer.addBatch` | One entry per summarized batch; rebuilds the in-memory `ToolCallRecord` map on `session_start` |
| `context-prune-summary` | `flushPending` (runtime: `pi.sendMessage` steer; session: `appendCustomMessageEntry`) | The summary message itself; IS in LLM context (replaces the pruned raw outputs) |
| `context-prune-stats` | `statsAccum.persist` | Cumulative summarizer token/cost snapshot |
| `context-prune-frontier` | `flushPending` | Last attempted prune boundary (advances even on `skipped-oversized` / `skipped-trivial` / `skipped-deduped`) |
| `context-prune-dedup-alias` | `indexer.registerDuplicate` | One entry per content-hash dedup hit; rebuilt on `session_start` to repopulate `dedupAliasToOriginal` |
| `context-prune-chain` | `chain-compressor.compressEligible` (called from `flushPending` in `index.ts` and from `/pruner compact`) | One entry per chain that has been range-dropped from LLM context; carries optional `rangeSummaryText` (fused LLM range summary) when `fuseRangeSummary` is on; also carries optional `protectedToolCallIds` (verbatim protected outputs - ids protected by tool name or path glob - are relocated into the synthetic body as `<protected-output>` tags at render time). Rebuilt on `session_start` to repopulate the chain registry. |

## Events emitted

The extension emits on the shared `pi.events` bus. These are **outbound live signals only** — not persisted to the session JSONL, not in the `context-prune-*` customTypes table above, not re-seeded on `session_start`.

| Channel | Constant | Payload | Semantics |
|---|---|---|---|
| `cost:external` | `EXTERNAL_COST_CHANNEL` | `ExternalCostUpdate { source: string; totalCost: number; inputTokens?: number; outputTokens?: number }` | Cumulative summarizer cost for the current session (USD). `source = EXTERNAL_COST_SOURCE = "pi-condense"`. Re-emitted on every update; aggregators key by `source` and replace. Live only: not persisted, not re-seeded on `session_start`. Designed for pi-cohort-style aggregators that fold multiple extension costs into one Σ$ total. |
