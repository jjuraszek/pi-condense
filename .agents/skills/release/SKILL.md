---
name: release
description: Creates a repository release for this Pi package. Use when the user asks to do a major, minor, or patch release, bump the package version, and create and push a git tag. This fork is consumed via git pins (`git:github.com/...@<sha>`); no npm publish step is involved.
---

# Release

Use this skill when asked to release this package, especially through `/release major`, `/release minor`, or `/release patch`.

## Repository-specific release model

This fork is consumed via git pins in pi `settings.json` (e.g.
`"git:github.com/jjuraszek/pi-context-prune@<sha>"`), not via npm. A release
here just means:

1. bump the version in `package.json`
2. create the release commit and the matching `vX.Y.Z` git tag
3. push `main` and the tag
4. update any pi `settings.json` pins to the new release commit sha

There is no CI publish workflow. **Do not run `npm publish`** — nothing
consumes the npm package; running it would only publish under whatever
account the local `npm` is logged into.

## Inputs

Accepted release types:
- `major`
- `minor`
- `patch`

If the user does not specify one of those three values, ask for clarification.

## Safety checks before releasing

Before running the release script, confirm all of the following:

- the repo working tree is clean
- the release should go from `main`
- the local checkout can fast-forward cleanly from `origin/main`
- the current package version comes from `package.json`

If any of those checks fail, stop and explain why.

## Preferred execution path

Use the helper script in this skill:

```bash
bash skills/release/scripts/release.sh <major|minor|patch>
```

Examples:

```bash
bash skills/release/scripts/release.sh patch
bash skills/release/scripts/release.sh minor
bash skills/release/scripts/release.sh major
```

For a no-side-effects validation run, use:

```bash
bash skills/release/scripts/release.sh --dry-run patch
```

## What the helper script does

The script is the authoritative release path for this repo. It:

1. validates the requested bump type
2. ensures the working tree is clean
3. fetches from `origin`
4. switches to `main` if needed
5. fast-forwards `main` from `origin/main`
6. runs `npm run build --if-present`
7. runs `npm run check --if-present`
8. runs `npm version <type> -m "Release %s"`
9. pushes `main`
10. pushes the newly created tag
11. prints the new version

## After the script succeeds

Report back with:

- the old version
- the new version
- the created tag (sha + name)
- confirmation that `main` and the tag were pushed
- a note that any pi `~/.pi/agent.*/settings.json` pins for this repo should
  be bumped to the new release commit sha so subsequent `pi update` runs
  pick up the change

## Failure handling

If the script fails:

- do not guess
- quote the failing command or the relevant stderr
- explain whether the release partially completed
- if `npm version` already created a commit/tag but push failed, tell the user exactly what happened before attempting cleanup

## Notes

- This skill is paired with the prompt template at `prompts/release.md` so the user can invoke it with `/release <major|minor|patch>`.
- Keep release responses concise and operational.
