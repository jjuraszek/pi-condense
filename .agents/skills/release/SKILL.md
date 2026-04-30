---
name: release
description: Run the pi-context-prune maintainer release workflow. Use when asked to do `/release major`, `/release minor`, or `/release patch` from this repository, including version bumping, tagging, pushing, and triggering npm publication.
---

# Release

This skill is **specific to the `pi-context-prune` repository**.

Use it when the user wants to cut a new release of this package with one of these semantic version bump types:

- `major`
- `minor`
- `patch`

## What this workflow does

For this repo, a release means:

1. bump the package version
2. create the matching git commit and tag (`vX.Y.Z`)
3. push the branch and tag to GitHub
4. let the existing GitHub Actions workflow publish the package to npm

The canonical release implementation lives in:

- `scripts/release.mjs`

The npm publish step is handled by:

- `.github/workflows/release.yml`

That workflow runs on pushed tags matching `v<semver>` and executes `npm publish --access public --provenance` with the repo's `NPM_TOKEN` secret.

## Required behavior

When using this skill:

1. Accept only `major`, `minor`, or `patch`.
2. State the chosen release type briefly before making changes.
3. Use the helper script instead of manually running a long sequence of release commands.
4. Do **not** run a separate local `npm publish` unless the user explicitly asks for a manual fallback.
   - In this repo, pushing the version tag is what triggers npm publication through GitHub Actions.
5. After the script finishes, report:
   - previous version
   - new version
   - created tag
   - pushed refs
   - that npm publication was triggered via GitHub Actions

## Preconditions

Before running the release script, verify or rely on the script's checks for all of the following:

- current repo is `pi-context-prune`
- release type is one of `major | minor | patch`
- current branch is `main`
- git working tree is clean
- local branch can fast-forward from `origin/main`

## Canonical command

Run this from the repo root:

```bash
node scripts/release.mjs <major|minor|patch>
```

Examples:

```bash
node scripts/release.mjs patch
node scripts/release.mjs minor
node scripts/release.mjs major
```

## What the script does

The helper script is the source of truth for the mutating steps. It:

1. validates the requested release type
2. verifies a clean working tree
3. verifies the current branch is `main`
4. fetches tags and fast-forwards from `origin/main`
5. runs:
   - `npm run check`
   - `npm pack --dry-run`
6. runs `npm version <type> -m "release: v%s"`
   - this updates `package.json`
   - this creates the release commit
   - this creates the git tag
7. pushes `main`
8. pushes the created tag
9. prints a short success summary

## Response format after success

Use a concise summary like:

- Released `OLD_VERSION -> NEW_VERSION`
- Created tag `vNEW_VERSION`
- Pushed `main` and `vNEW_VERSION` to `origin`
- GitHub Actions publish workflow has been triggered for npm publication

## Failure handling

If the script fails:

1. stop and do not guess
2. inspect the script output
3. explain clearly which step failed
4. if `npm version` already succeeded, mention that a release commit and tag may already exist locally
5. propose the smallest safe recovery step

Typical recovery hints:

- if the tree is dirty: commit or stash changes first
- if not on `main`: switch to `main`
- if fast-forward pull fails: resolve divergence before releasing
- if push of `main` or the tag fails: inspect remote/auth state before retrying

## Notes for `/release ...`

This repo also defines a prompt template at `.pi/prompts/release.md`.
When a user invokes `/release major`, `/release minor`, or `/release patch`, that prompt should route into this skill and then run the canonical script above.
