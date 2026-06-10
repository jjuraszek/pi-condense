---
name: 034-fix-npm-trusted-publishing-release
description: Fix the npm trusted publishing release workflow so GitHub Actions can publish without a stale auth-token line, then cut a patch release to verify the path.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the failing release run and identify the remaining auth source"
      - "- [x] step 2: confirm the token secret has been removed from GitHub"
  - phase: implementation
    steps:
      - "- [ ] step 1: remove setup-node's auth-token line from the release workflow before publish"
      - "- [ ] step 2: keep the workflow aligned with trusted publishing and current Node/npm guidance"
  - phase: validation
    steps:
      - "- [ ] step 1: commit and push the workflow fix to main"
      - "- [ ] step 2: run the patch release and verify the publish workflow succeeds"
---

# 034-fix-npm-trusted-publishing-release

## Phase 1 — Discovery
- [x] step 1: inspect the failing release run and identify the remaining auth source
- [x] step 2: confirm the token secret has been removed from GitHub

## Phase 2 — Implementation
- [ ] step 1: remove setup-node's auth-token line from the release workflow before publish
- [ ] step 2: keep the workflow aligned with trusted publishing and current Node/npm guidance

## Phase 3 — Validation
- [ ] step 1: commit and push the workflow fix to main
- [ ] step 2: run the patch release and verify the publish workflow succeeds
