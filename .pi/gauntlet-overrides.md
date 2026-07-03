# pi-gauntlet overrides (pi-condense)

Read by the pi-gauntlet skills (`brainstorming`, `writing-plans`, `finishing-a-development-branch`, ...) when they check for `.pi/gauntlet-overrides.md`. Sections below override or extend the matching skill instructions for this repo.

## Plan retention (writing-plans, finishing-a-development-branch)

- **`doc/specs/` is the only durable artifact.** Specs land on the base branch and stay.
- **`doc/plans/` is ephemeral.** A plan lives only on its feature branch. Before finishing a branch, `git rm doc/plans/<plan-file>.md` so it never reaches `main`; the plan survives in the deleted branch's git history if needed. Never commit a plan to `main`.
- Most changes here are gauntlet-driven, so this repo keeps `doc/plans/` out of the tracked tree on `main` by construction.

## Tickets (any skill that files an issue)

Every GitHub issue follows: **Context -> Problem -> Idea (how to address) -> Acceptance Criteria**, then the idea is **roasted by 2 subagents and the consolidated roast is posted as a comment** before the issue is considered ready. See `AGENTS.md` (Ticket convention) for the canonical form.
