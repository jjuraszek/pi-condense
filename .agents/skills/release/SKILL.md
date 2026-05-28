---
name: release
description: Creates a repository release for this Pi package. Use when the user asks to do a major, minor, or patch release, bump the package version, and create and push a git tag. This fork is consumed via git tag pins (`git:github.com/...@vX.Y.Z`); no npm publish step is involved.
---

# Release

Use this skill when asked to release this package, especially through `/release major`, `/release minor`, or `/release patch`.

## Repository-specific release model

This fork is consumed via **git tag pins** in pi `settings.json` (e.g.
`"git:github.com/jjuraszek/pi-context-prune@v0.11.1"`), not via npm. A release
here means:

1. bump the version in `package.json`
2. create the release commit and the matching `vX.Y.Z` git tag
3. push `main` and the tag to `origin`
4. rewrite every `~/.pi/agent*/settings.json` that pins this repo so its
   `@<old-ref>` becomes `@vX.Y.Z` (done by the helper script — no manual
   bump anymore)

There is no CI publish workflow. **Do not run `npm publish`** — nothing
consumes the npm package; running it would only publish under whatever
account the local `npm` is logged into.

The tag scheme (`v` prefix, semver) matches sibling pi packages, e.g.
[`pi-superpowers`](https://github.com/jjuraszek/pi-superpowers/tags).

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

Use the helper script in this skill (paths are relative to repo root):

```bash
bash .agents/skills/release/scripts/release.sh <major|minor|patch>
```

Examples:

```bash
bash .agents/skills/release/scripts/release.sh patch
bash .agents/skills/release/scripts/release.sh minor
bash .agents/skills/release/scripts/release.sh major
```

For a no-side-effects validation run:

```bash
bash .agents/skills/release/scripts/release.sh --dry-run patch
```

To release without touching the user's settings.json pins (rare — e.g. when
releasing from a host that doesn't have a pi profile):

```bash
bash .agents/skills/release/scripts/release.sh --no-update-pins patch
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
8. runs `npm version <type> -m "Release %s"` (creates commit + `vX.Y.Z` tag)
9. pushes `main` and the new tag
10. rewrites every `~/.pi/agent*/settings.json` that pins
    `git:github.com/jjuraszek/pi-context-prune@<ref>` so `<ref>` becomes the
    new tag. Anything not matching that exact prefix (upstream URL, other
    forks) is left alone.

## After the script succeeds

Report back with:

- the old version
- the new version
- the created tag (sha + name)
- confirmation that `main` and the tag were pushed
- which `~/.pi/agent*/settings.json` files got their pin bumped (taken from
  the script's stdout — it prints one line per rewritten file)

If `--no-update-pins` was used, instead remind the user to bump pins
manually:

```bash
grep -nrH 'git:github.com/jjuraszek/pi-context-prune@' $HOME/.pi/agent*/settings.json
```

## Failure handling

If the script fails:

- do not guess
- quote the failing command or the relevant stderr
- explain whether the release partially completed
- if `npm version` already created a commit/tag but push failed, tell the user exactly what happened before attempting cleanup
- if the tag pushed but the pin rewrite failed, the release is still valid —
  re-running just the pin step is safe (the helper is idempotent: pins already
  on `vX.Y.Z` are skipped). The user can re-run with `--no-update-pins`
  bypassed via:
  `bash .agents/skills/release/scripts/release.sh --dry-run patch` (to see
  what would change) then bump manually with `sed`/`jq`/an editor.

## Notes

- This skill is paired with the prompt template at `prompts/release.md` so the user can invoke it with `/release <major|minor|patch>`.
- Keep release responses concise and operational.
