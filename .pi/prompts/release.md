---
description: Cut a pi-context-prune release by bumping semver, tagging, pushing, and triggering npm publication
argument-hint: "<major|minor|patch>"
---
Use the project-local `release` skill from `.agents/skills/release/SKILL.md` to perform a `$1` release for `pi-context-prune` now.

Requirements:
- Accept only `major`, `minor`, or `patch`.
- Before mutating anything, briefly state the release type and confirm you are following the repo's release skill.
- Execute the canonical scripted workflow in `scripts/release.mjs`.
- Do not use a manual local `npm publish` unless the scripted/tag-driven workflow is unavailable and I explicitly ask for a fallback.
- After completion, report the old version, new version, created tag, pushed refs, and that npm publication was triggered through GitHub Actions.

Release type: `$1`
Additional instructions: `${@:2}`
