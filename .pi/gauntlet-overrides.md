# pi-gauntlet overrides (pi-condense)

Read by pi-gauntlet skills through their "Project overrides" hook. Sections below override or extend the matching skill instructions for this repo.

## Issue tracker

- tracker: github
- repo: jjuraszek/pi-condense
- refs: `#N` in commit bodies and CHANGELOG entries; `(#N)` trailing in CHANGELOG bullets

Write-gate carve-out: a user instruction that names the write ("close #12 with a comment", "comment the changelog on #12") is the confirmation - execute, then report. Agent-initiated bodies and comments keep the package confirm gate. Status changes (`gh issue close/reopen`) are announced, not gated.

## Release (any skill that ships)

`/skill:release` is the only ship path; there is no PR gate on `main`. A user instruction naming the level (`release patch`) authorizes the whole run - `release.sh <level>` through `verify` - with no proposal step and no re-confirmation. Follow-ups bundled in the same instruction (close a ticket, post the CHANGELOG section as a comment) run after `verify` prints the version.

## Plan retention (writing-plans, finishing-a-development-branch)

- **`doc/specs/` is the only durable artifact.** Specs land on the base branch and stay.
- **`doc/plans/` is ephemeral.** A plan lives only on its feature branch. Before finishing a branch, `git rm doc/plans/<plan-file>.md` so it never reaches `main`; the plan survives in the deleted branch's git history if needed. Never commit a plan to `main`.
- Most changes here are gauntlet-driven, so this repo keeps `doc/plans/` out of the tracked tree on `main` by construction.
