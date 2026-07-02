---
name: release
description: Use when asked to release, publish, bump the version, or cut a tag for jjuraszek/pi-condense.
---

# Release

Use this skill when asked to release this package.

## Overview

`pi-condense` publishes to **npm** (public, unscoped); the `pi-package` keyword
lists it on `https://pi.dev/packages/pi-condense`. Users install with
`pi install npm:pi-condense`.

The release is **tag-driven and CI-executed**: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which gates on `tag == package.json`, runs
`bun test src/`, and runs `npm publish --provenance --access public` via
**OIDC trusted publishing**. The local flow only assigns the version and pushes
the tag; **never run `npm publish` by hand.**

All mechanics live in `.agents/skills/release/scripts/release.sh`. This skill is
the judgment layer around it: propose the level, get approval, then run the
script. The script's config header is the only part that differs from the
sibling pi-* copies (`pi-cohort`, `pi-gauntlet`) - keep them in sync.

## Boundaries

- Reads: git log/tags, `package.json`, `CHANGELOG.md`, pi `settings.json` files.
- Writes (only when you run the matching command): `package.json` version, a
  release commit, the `vX.Y.Z` tag, and - only with an explicit `--apply` and a
  separate approval - `settings.json` pins.
- Does NOT: run `npm publish`, edit consumer project files, or rewrite
  `~/.pi/**/settings.json` without a distinct approval for that action.

## Tag scheme

`v<major>.<minor>.<patch>` - plain semver, matching the workflow filter
`v[0-9]+.[0-9]+.[0-9]+`. `package.json` `version` mirrors the tag without the
leading `v`.

## Bump policy

| Level | When |
|---|---|
| `patch` | fixes, prose, internal changes that don't alter behavior |
| `minor` | new command, config key, tool surface, or backward-compatible feature |
| `major` | breaking change: config-schema break, removed command, changed customType wire format |

## Process

### 1. Propose the level - require explicit approval

```bash
bash .agents/skills/release/scripts/release.sh propose
```

Present the commits, the heuristic level, and the resulting `X.Y.Z` with a
one-line rationale tied to specific commits. **Stop and wait** for the user to
accept or override. Never pick the level and proceed in one step.

### 2. Move the CHANGELOG entry

Promote the `## [Unreleased]` notes into a new `## [X.Y.Z] - <date>` heading for
the agreed version (Keep-a-Changelog format). Draft one if none exist.

### 3. Bump, tag, push - require explicit approval of the exact command

```bash
bash .agents/skills/release/scripts/release.sh minor     # or patch / major
bash .agents/skills/release/scripts/release.sh current    # version already hand-set + committed
bash .agents/skills/release/scripts/release.sh --dry-run minor   # preview, no changes
```

The script verifies `main` + a clean tree, bumps `package.json`, commits
`Release <version>`, runs `bun test src/` as a pre-flight, creates the
annotated tag, pushes `main` + the tag, then chains straight into verification.
`current` tags the version already in `package.json` (commit your work first).

### 4. Verification (the script runs this automatically after a push)

To re-run standalone:

```bash
bash .agents/skills/release/scripts/release.sh verify           # current package.json version
bash .agents/skills/release/scripts/release.sh verify 1.5.0
```

It watches the release workflow to a terminal state (`gh` if present), polls
`npm view pi-condense@X.Y.Z version` until live, then checks the pi.dev catalog.
Only claim success once `npm view` prints the new version. pi.dev lags npm by
minutes to hours - report crawl lag, do not loop on it.

### 5. Optional - propose preset pin sync

Offer only when relevant. Requires its own explicit approval before `--apply`.

```bash
bash .agents/skills/release/scripts/release.sh sync-presets            # report only
bash .agents/skills/release/scripts/release.sh sync-presets --apply    # rewrite same-form npm pins
```

Scans `settings.json` under `~/.pi` and this repo's parent tree. Same-form npm
pins (`npm:pi-condense@<old>`) are bumped by `--apply`; git-tag pins and stale
`pi-context-prune` names are reported for manual migration, never auto-rewritten.

## Safety checks

Refuse to proceed unless ALL hold; report which failed, do not silently fix:

- working tree clean (for `current`, commit feature work first)
- releasing from `main`
- the target `vX.Y.Z` tag does not already exist (the script enforces this)
- `bun test src/` passes (the script's pre-flight; also the CI gate)

## Red Flags - STOP

- about to run `npm publish` locally - push the tag, let CI publish
- picked the bump level without user confirmation
- reported success without `npm view pi-condense@X.Y.Z` printing the version
- retrying the pi.dev fetch "until it appears" - that's crawl lag, not failure
- editing a `~/.pi/**/settings.json` without its own explicit approval
- `package.json` version and the tag are not the identical `X.Y.Z` string

## First-time npm setup (one-off, not per release)

`pi-condense` must be registered once as a **trusted publisher** on npmjs.com:
Settings -> Trusted Publishing -> GitHub Actions publisher for repo
`jjuraszek/pi-condense`, workflow `release.yml`. Until it exists the publish step
cannot authenticate (403).
