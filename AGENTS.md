# pi-condense

Pi extension that captures completed tool-call batches, summarizes them with an LLM, replaces raw tool results with short stubs in future context, and exposes `context_tree_query` to recover originals on demand. Published to npm as `pi-condense` (`pi install npm:pi-condense`).

<!-- agents-core:begin v3 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Ground Truth Before Reasoning

User instructions outrank skill and AGENTS.md guidance; on conflict, follow the user. Configured gates (design approval, ship verification) still run; a user instruction that already names the gated action satisfies its confirmation.

Never guess Pi's API, message shapes, config, or values - read the source. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner`; its shipped `.d.ts` is API truth. Third-party APIs: never state a signature, config key, flag, or version-specific behavior from memory - verify in current docs (Context7 `resolve-library-id` then `query-docs`). If the source contradicts your assumption, the source wins; if it is missing, say so and ask - do not fabricate. Check the request's premise before acting: if the source contradicts it, say so once with evidence, then follow the user's decision.

The same rule applies to state you set up yourself. Before asserting that a job, publish, CI run, or process is in some state, run the command that shows it in this turn (`gh run view`, `npm view`, `git status`). A summary of what you started is a plan, not an observation.

## Authorization

An instruction that names an action and its parameters is the approval for that action ("release patch", "close #12 with a comment") - do it, then report. Ask only when a parameter is ambiguous or a safety check fails; say what failed, don't fix it silently. Once the design is settled, finish the authorized work before asking - the user approves a concrete result. Reversible, read-only, and already-authorized actions need no permission. Agent-initiated writes to a tracker or to files outside the repo keep their gate.

## Communication Style

**North star: sharp, human-readable, example-driven, condense.** Sharp = exact, no hedging (name the file/SHA/value). Human-readable = written like a person, not a report. Example-driven = a small before/after beats a paragraph. Condense = every sentence earns its place. One term per concept: name a thing once, reuse that name. A reply carries its substance inline - never point at tool outputs, finding numbers, or earlier turns the reader didn't see; restate in one sentence.

| Regime | Surfaces | Format |
|---|---|---|
| Human-facing comms | chat, commit messages, PR/issue bodies and comments, review feedback | no scaffolding (no Options/TL;DR templates, no headings on short comments); bullets over prose; end on the ask, not a summary |
| LLM-readable artifacts | AGENTS.md, README, CHANGELOG, specs, plans, skill/agent/prompt files, non-obvious-why code comments | tables, headings, explicit field references, code blocks; density still binds; optimize for unambiguous retrieval |

**Suppress process narration.** No intent classification, phase/routing announcements, tool/subagent preamble, status narration, pleasantries. **Output instead:** outcomes, decisions needing input, verification results, blockers. Start with the substance.

ASCII punctuation everywhere (chat, comments, commits, docs, code): `-` not em-dash, `...` not the ellipsis glyph, straight quotes; non-ASCII only for a justified visual mark. State what you did or will do; don't pad with what you won't do, what stays unchanged, or alternatives nobody asked about. No closing summaries.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No new machinery if not essential.** Reuse an existing field, channel, or code path (plus a small discriminant if needed) over a new sibling construct; new machinery must earn its place by being impossible or misleading to express with what exists.
- **No belt-and-suspenders.** Validate a thing once, at the boundary that owns it - not at every layer.
- **Delete dead code, don't comment it out.** When a change supersedes code, remove the old path in the same commit. Branch from the deletion commit if reversibility matters.
- **Comments are stock, not flow.** Record the durable why, never task context, tickets, or callers. Good: `// output is never empty for a real dispatch`. Bad: `// #12: gate on this so the classifier doesn't no-op`. No docstrings on self-evident params/returns, no banner comments.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.
- **Docs are a current contract, present tense.** No "upcoming"/"pending" in a current-state guide - planned work lives in `doc/specs/`, `doc/plans/`, or the ticket; history lives in `CHANGELOG.md` and commit bodies, never in AGENTS.md or a guide. Doc updates ride with the commit that makes them stale. Editing a doc puts the smallest unit you touch - bullet, row, heading block - in scope: its paths resolve, its commands match the source, its framing is present tense; stale content outside that unit: flag, don't fix.
- **AGENTS.md is always-on essentials plus routing, not the manual.** Route detail to `doc/` or `README.md` and link it; add an inline pointer only when critical or high-frequency. README and AGENTS.md stay in sync where they overlap.
- **Markdown tables use compact `|---|` separators.** Never padded columns.

## Ticket convention

Creating a ticket or repairing its title/body/metadata happens only via `/skill:shape-ticket` - it enforces the Context -> Problem -> Idea -> Acceptance Criteria template, an AC integrity gate, and a cheap council roast applied to the body before the single human-gated write (no roast comments); a user instruction naming the ticket's body counts as that gate. Status transitions and comments are exempt - plain tracker CLI.

<!-- agents-core:end v3 -->

## Part of one platform

One of four sibling pi extensions - **pi-quiver** (capabilities), **pi-cohort** (coordination), **pi-condense** (context economy), **pi-gauntlet** (process). They ship and version independently; a concept is explained in its owning repo and linked from the others, never duplicated.

- No code dependency on any sibling.
- Runtime coupling: pi-condense emits `cost:external` (`EXTERNAL_COST_CHANNEL`, payload `ExternalCostUpdate`, `source: "pi-condense"`, cumulative, live only); pi-cohort aggregates it into `Σ$`. The channel is generic; pi-condense names pi-cohort as the intended consumer, not the owner. Contract: [`README.md`](README.md#external-cost-channel).

A change to the `cost:external` payload shape or semantics updates pi-cohort's `doc/observability.md` in the same logical change and lands in both CHANGELOGs.

## Ground truth pointers

Field names matter (`id` vs `toolCallId`, `arguments` vs `input`); the type files are authoritative.

- Pi event/extension API: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` - `ExtensionAPI`, `ExtensionContext`, every `pi.on(...)` payload, `appendEntry`, `setActiveTools`, `setWidget`, `sendMessage`.
- LLM message shapes: `node_modules/@earendil-works/pi-ai/dist/types.d.ts` - `AssistantMessage`, `ToolResultMessage`, `ToolCall`, `UsageInfo`.
- pi-ai auto-repair: `node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js` - `insertSyntheticToolResults` injects `{ isError: true, "No result provided" }` for orphaned tool calls; this is why `src/pruner.ts` returns stub messages instead of deleting them.
- Session entry layout: `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` - `getBranch()` returns `SessionEntry[]` (wrapped messages), not `AgentMessage[]`.

## Layout

```
index.ts                  # extension entry point, wires all events
src/pruner.ts             # pruneMessages: stub-replace -> supersede -> error-purge -> chain-range-prune -> orphan-sweep
src/chain-*.ts            # closed-chain detection, positional range prune, compression orchestrator
src/indexer.ts            # tool-call index + chain registry + summary body tracking (occurrence-keyed)
src/summarizer*.ts        # LLM summarization + sticky outage fallback
src/commands.ts           # /pruner subcommands, settings overlay, status widget
src/diagnostics.ts        # context-prune-diagnostic sink, never in LLM context
src/types.ts              # shared types, constants, DEFAULT_CONFIG
src/test-support.ts       # shared test helpers (expectNoOrphanToolResults)
PRUNING.md                # algorithm, session entry types, design rationale, research refs
doc/specs/                # durable specs; reach main
doc/plans/                # ephemeral plans; git rm before ship, never on main
```

Session entry `customType`s and what each carries: [`PRUNING.md`](PRUNING.md#session-entry-types).

## Workflow

- Multi-step work runs `/skill:brainstorming` -> `/skill:writing-plans` in a git worktree (`.worktrees/<branch>`, gitignored); the spec is the first commit on the branch.
- Smoke-test end-to-end with `pi -e ./index.ts --no-extensions -p "..."` against an isolated `$PI_CODING_AGENT_DIR`; verify the expected `context-prune-*` entries: `jq -r 'select(.type == "custom" or .type == "custom_message") | .customType' session.jsonl | sort | uniq -c`.

## Testing

`bun test src/` (also `npm test`; the CI and release gate). No typecheck script is wired: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` (transient `@types/node` add/remove is fine - don't commit it).

## Release

`/skill:release` owns the flow: `release.sh <level>` promotes `## [Unreleased]` in `CHANGELOG.md`, bumps `package.json`, commits `Release X.Y.Z`, tests, tags `vX.Y.Z`, pushes; CI publishes via OIDC. A user instruction naming the level is the approval. Mechanics and safety checks: [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md).

## Routing

| Want to ... | Read |
|---|---|
| Install, configure, `/pruner` commands and settings, `cost:external` contract | [`README.md`](README.md) |
| What pruning does, the algorithm, session entry types, design rationale, references | [`PRUNING.md`](PRUNING.md) |
| What changed across versions | [`CHANGELOG.md`](CHANGELOG.md) |
| Rationale for a past change | `doc/specs/*.md` |
| pi-gauntlet skill overrides for this repo (plan retention, tracker) | [`.pi/gauntlet-overrides.md`](.pi/gauntlet-overrides.md) |
| Run a release | [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md) |
| Change the shared AGENTS core | edit [`AGENTS.core.md`](AGENTS.core.md), `node scripts/check-agents-core.mjs --fix`, copy both files to the siblings, `--fix` there |
