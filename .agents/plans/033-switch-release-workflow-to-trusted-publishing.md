---
name: 033-switch-release-workflow-to-trusted-publishing
description: Replace token-based npm publishing in the GitHub Actions release workflow with npm trusted publishing and document the required npm-side setup.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current release workflow and auth wiring"
      - "- [x] step 2: confirm npm trusted publishing requirements from the docs"
  - phase: implementation
    steps:
      - "- [x] step 1: update the GitHub Actions workflow to rely on OIDC trusted publishing"
      - "- [x] step 2: remove token-based publish auth and refresh comments"
  - phase: validation
    steps:
      - "- [x] step 1: verify the workflow file is internally consistent"
      - "- [x] step 2: note the npm-side setup the maintainer must complete"
---

# 033-switch-release-workflow-to-trusted-publishing

## Phase 1 — Discovery
- [x] step 1: inspect the current release workflow and auth wiring
- [x] step 2: confirm npm trusted publishing requirements from the docs

## Phase 2 — Implementation
- [x] step 1: update the GitHub Actions workflow to rely on OIDC trusted publishing
- [x] step 2: remove token-based publish auth and refresh comments

## Phase 3 — Validation
- [x] step 1: verify the workflow file is internally consistent
- [x] step 2: note the npm-side setup the maintainer must complete
