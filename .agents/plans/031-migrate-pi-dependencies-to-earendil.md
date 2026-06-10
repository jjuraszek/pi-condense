---
name: 031-migrate-pi-dependencies-to-earendil
description: Update Pi package imports and peer dependencies from the old mariozechner scope to the new earendil-works scope, then validate and publish the change.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the repo for all mariozechner scoped package references"
      - "- [x] step 2: confirm the new package scope and migration guidance"
  - phase: implementation
    steps:
      - "- [x] step 1: update package metadata and source imports to @earendil-works"
      - "- [x] step 2: update the lockfile references that mirror the package scope change"
  - phase: validation
    steps:
      - "- [x] step 1: verify there are no remaining mariozechner references in tracked source files"
      - "- [x] step 2: commit the change and push it to main"
---

# 031-migrate-pi-dependencies-to-earendil

## Phase 1 — Discovery
- [x] step 1: inspect the repo for all mariozechner scoped package references
- [x] step 2: confirm the new package scope and migration guidance

## Phase 2 — Implementation
- [x] step 1: update package metadata and source imports to @earendil-works
- [x] step 2: update the lockfile references that mirror the package scope change

## Phase 3 — Validation
- [x] step 1: verify there are no remaining mariozechner references in tracked source files
- [x] step 2: commit the change and push it to main
