# pi-context-prune

Pi extension. Captures completed tool-call batches, summarizes them with an LLM, replaces raw tool results with short stubs in future context, and exposes `context_tree_query` to recover originals on demand. Targeted at long agent sessions where raw tool outputs dominate the prompt.

## Communication Style

Same rules as the parent `~/.pi/agent.anthropic/AGENTS.md`. Applied to chat, commit messages, PR descriptions, code review, and any artifact authored in this repo.

- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts (issues, PRs, chat). Casual thread → casual reply.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `PRUNING.md`, `doc/specs/*.md`, `.agents/skills/*/SKILL.md`, code comments where *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers — pick one. Validate at the boundary once.
- **Delete dead code, don't comment it out.** If a replacement is uncertain, branch from the deletion commit so you can revert.
- **Comments only when the *why* is non-obvious** — hidden constraint, subtle invariant, surprising workaround. Don't restate what the code does. No docstrings on self-evident params/returns. No banner comments. Don't reference the current task or callers — that belongs in the commit message.
- **Docs are a contract.** Dense, current, no preamble. If a sentence doesn't help a future reader act on the contract, cut it. AGENTS.md routes; PRUNING.md explains the algorithm; README.md installs/configures. Each stays terse.
- **Markdown tables use compact separators** (`|---|`, never padded).
- **Surface, don't auto-fix.** A bug fix doesn't drag surrounding cleanup; a one-shot operation doesn't grow a helper. Mention adjacent issues separately.

## Ground Truth Before Reasoning

Never guess Pi's API or message shapes. Read the source.

- **Pi event/extension API:** `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` — `ExtensionAPI`, `ExtensionContext`, every `pi.on(...)` event payload, `appendEntry`, `setActiveTools`, `setWidget`, `sendMessage`.
- **LLM message shapes:** `node_modules/@mariozechner/pi-ai/dist/types.d.ts` — `AssistantMessage`, `ToolResultMessage`, `ToolCall`, `UsageInfo`. Field names matter (`id` vs `toolCallId`, `arguments` vs `input`); the type files are authoritative.
- **pi-ai's auto-repair behavior:** `node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js` — `insertSyntheticToolResults` injects `{ isError: true, "No result provided" }` for orphaned tool calls. Knowing this is the reason `src/pruner.ts` returns stub messages instead of deleting them.
- **Session entry layout:** `node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.d.ts` — `getBranch()` returns `SessionEntry[]` (wrapped messages), not `AgentMessage[]`.

If the source contradicts an assumption, the source wins. If the source is missing, say so and ask — don't fabricate.

## Routing

| Want to … | Read |
|---|---|
| Understand what pruning does, why, the algorithm, design rationale, references | [`PRUNING.md`](PRUNING.md) |
| Install, configure, list of `/pruner` commands and settings | [`README.md`](README.md) |
| Implementation: hook a Pi event, change the indexer, touch the summarizer | open the matching `src/*.ts` file directly |
| Run a release | `.agents/skills/release/SKILL.md` |
| Brainstorm / plan a multi-step change | superpowers `brainstorming` then `writing-plans` skills; specs land in `doc/specs/` |
| Historical context for a past change | `doc/specs/*.md` (newest first) |

## Workflow

- **Multi-step work uses the superpowers `brainstorming` → `writing-plans` skills.** Specs and plans live in `doc/specs/` (`YYYY-MM-DD-<topic>.md`). Keep the checklist in sync with reality.
- **Isolate feature work in a git worktree.** Worktrees default to `.worktrees/<branch>` at the repo root (already gitignored); use the superpowers `using-git-worktrees` skill. The spec is the first commit on the branch.
- **Releases use the `release` skill.** This fork is consumed via git **tag** pins (`git:github.com/jjuraszek/pi-context-prune@vX.Y.Z`); the release script bumps the version, creates and pushes the `vX.Y.Z` tag, then automatically rewrites every matching pin in `~/.pi/agent*/settings.json`. No npm publish step. The tag scheme matches sibling pi-* packages (`pi-superpowers`, etc.). See `.agents/skills/release/SKILL.md` for the full flow + `--dry-run` / `--no-update-pins` flags.
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
  stats.ts                         # StatsAccumulator + formatting helpers
  types.ts                         # all shared types, constants, DEFAULT_CONFIG
  (other src/*.ts)                 # frontier, config, dedup, tree-browser, context-prune-tool
.agents/skills/                    # in-repo skills (release)
doc/specs/                         # specs + plans (superpowers brainstorming/writing-plans)
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
| `context-prune-chain` | `chain-compressor.compressEligible` (called from `flushPending` in `index.ts` and from `/pruner compact`) | One entry per chain that has been range-dropped from LLM context; carries optional `rangeSummaryText` (fused LLM range summary) when `fuseRangeSummary` is on; also carries optional `protectedToolCallIds` (verbatim protected outputs are relocated into the synthetic body as `<protected-output>` tags at render time). Rebuilt on `session_start` to repopulate the chain registry. |
