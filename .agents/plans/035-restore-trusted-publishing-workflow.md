---
name: 035-restore-trusted-publishing-workflow
description: Switch the npm release workflow back from token-based auth to npm trusted publishing now that the package has a trusted publisher configured on npm.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current release workflow and confirm it still uses NPM_TOKEN"
      - "- [x] step 2: confirm the repo is clean and ready for a focused workflow-only change"
  - phase: implementation
    steps:
      - "- [x] step 1: remove token-based npm auth from the release workflow"
      - "- [x] step 2: keep OIDC/trusted-publishing requirements explicit in the workflow comments and permissions"
  - phase: validation
    steps:
      - "- [x] step 1: verify the workflow syntax and resulting diff"
      - "- [ ] step 2: commit and push the trusted-publishing workflow update"
---

# 035-restore-trusted-publishing-workflow

## Phase 1 — Discovery
- [x] step 1: inspect the current release workflow and confirm it still uses NPM_TOKEN
- [x] step 2: confirm the repo is clean and ready for a focused workflow-only change

## Phase 2 — Implementation
- [x] step 1: remove token-based npm auth from the release workflow
- [x] step 2: keep OIDC/trusted-publishing requirements explicit in the workflow comments and permissions

## Phase 3 — Validation
- [x] step 1: verify the workflow syntax and resulting diff
- [ ] step 2: commit and push the trusted-publishing workflow update
