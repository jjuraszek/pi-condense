---
name: 027-commit-and-patch-release
description: Commit the latest context_prune progress-update changes, push main, then perform a patch release using the repository release workflow.
steps:
  - phase: discovery
    steps:
      - "- [ ] step 1: inspect git status, current branch, package version, and release workflow/script availability"
      - "- [ ] step 2: confirm the working tree can be made clean and main can be released safely"
  - phase: implementation
    steps:
      - "- [ ] step 1: commit and push the current uncommitted changes to main"
      - "- [ ] step 2: run the repository patch release helper and let it create the release commit and tag"
  - phase: validation
    steps:
      - "- [ ] step 1: verify the resulting version, tag, and push status"
      - "- [ ] step 2: update the plan to reflect the completed release"
---

# 027-commit-and-patch-release

## Phase 1 — Discovery
- [ ] step 1: inspect git status, current branch, package version, and release workflow/script availability
- [ ] step 2: confirm the working tree can be made clean and main can be released safely

## Phase 2 — Implementation
- [ ] step 1: commit and push the current uncommitted changes to main
- [ ] step 2: run the repository patch release helper and let it create the release commit and tag

## Phase 3 — Validation
- [ ] step 1: verify the resulting version, tag, and push status
- [ ] step 2: update the plan to reflect the completed release
