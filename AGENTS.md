# pi-context-prune

Pi extension. Captures completed tool-call batches, summarizes them with an LLM, replaces raw tool results with short stubs in future context, and exposes `context_tree_query` to recover originals on demand. Targeted at long agent sessions where raw tool outputs dominate the prompt.

## Communication Style

Same rules as the parent `~/.pi/agent.anthropic/AGENTS.md`. Applied to chat, commit messages, PR descriptions, code review, and any artifact authored in this repo.

- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts (issues, PRs, chat). Casual thread → casual reply.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `PRUNING.md`, `.agents/plans/*.md`, `.agents/skills/*/SKILL.md`, code comments where *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

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
| Plan a multi-step change | `.agents/skills/planning/SKILL.md` |
| Historical context for a past change | `.agents/plans/NNN-*.md` (newest first; `archived/` for retired plans) |
| Past exploratory writeups | `.agents/investigations/*.md` |

## Workflow

- **Multi-step work uses the `planning` skill.** Plans live in `.agents/plans/`, zero-padded numbered (`031-...`, `032-...`). Keep the checklist in sync with reality. Append at the end of the active plan rather than starting a new one for trivially small follow-ups.
- **Releases use the `release` skill.** This fork is consumed via git pins (`git:github.com/jjuraszek/pi-context-prune@<sha>`); the release script bumps the version + tag and pushes. No npm publish step. After release, bump the sha in every `~/.pi/agent.*/settings.json` that pins this package.
- **Smoke-test new behavior end-to-end** with `pi -e ./index.ts --no-extensions -p "..."` against an isolated `$PI_CODING_AGENT_DIR`. Inspect session JSONL entries (`jq -r 'select(.type == "custom" or .type == "custom_message") | .customType' session.jsonl | sort | uniq -c`) to verify the expected `context-prune-*` entries are written.
- **Typecheck before committing.** No package script is wired; run `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove is fine — don't commit it).

## Project Layout

```
index.ts                # extension entry point, wires events
src/                    # one concern per file; names describe the concern
.agents/plans/          # numbered plan docs (planning skill)
.agents/skills/         # in-repo skills (planning, release)
.agents/investigations/ # exploratory writeups
PRUNING.md              # algorithm + design rationale + research refs
README.md               # install + config + command reference
package.json            # pi-extension manifest (declares `./index.ts`)
```

Custom session entry types written by the extension (NOT in LLM context unless noted):

| customType | Written by | Purpose |
|---|---|---|
| `context-prune-index` | `indexer.addBatch` | One entry per summarized batch; rebuilds the in-memory `ToolCallRecord` map on `session_start` |
| `context-prune-summary` | `flushPending` (runtime: `pi.sendMessage` steer; session: `appendCustomMessageEntry`) | The summary message itself; IS in LLM context (replaces the pruned raw outputs) |
| `context-prune-stats` | `statsAccum.persist` | Cumulative summarizer token/cost snapshot |
| `context-prune-frontier` | `flushPending` | Last attempted prune boundary (advances even on `skipped-oversized` / `skipped-trivial` / `skipped-deduped`) |
| `context-prune-dedup-alias` | `indexer.registerDuplicate` | One entry per content-hash dedup hit; rebuilt on `session_start` to repopulate `dedupAliasToOriginal` |
