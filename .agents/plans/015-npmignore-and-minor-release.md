---
name: 015-npmignore-and-minor-release
description: Exclude the repository's .agents folder from the npm package, then commit, push main, and run a minor release.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current npm packaging files and release workflow prerequisites"
      - "- [x] step 2: confirm the working tree and branch state before making changes"
  - phase: implementation
    steps:
      - "- [x] step 1: add .agents to npm ignore rules"
      - "- [x] step 2: review the resulting diff and keep the change minimal"
      - "- [ ] step 3: commit the packaging change on main"
      - "- [ ] step 4: push the commit to origin/main"
  - phase: release
    steps:
      - "- [ ] step 1: run the repository minor release flow"
      - "- [ ] step 2: confirm the new version, tag, and push status"
---

# 015-npmignore-and-minor-release

## Phase 1 — Discovery
- [x] step 1: inspect the current npm packaging files and release workflow prerequisites
- [x] step 2: confirm the working tree and branch state before making changes

## Phase 2 — Implementation
- [x] step 1: add .agents to npm ignore rules
- [x] step 2: review the resulting diff and keep the change minimal
- [ ] step 3: commit the packaging change on main
- [ ] step 4: push the commit to origin/main

## Phase 3 — Release
- [ ] step 1: run the repository minor release flow
- [ ] step 2: confirm the new version, tag, and push status
