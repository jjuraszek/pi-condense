---
name: 032-remove-release-skill-from-package
description: Prevent the repository's release helper materials from shipping in the Pi package so only the /pruner command is exposed.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current package manifest and published files for release-related assets"
      - "- [x] step 2: confirm the source of the unwanted /release command registration"
  - phase: implementation
    steps:
      - "- [x] step 1: remove skill/prompt packaging hooks so the Pi package only exposes the extension entry point"
      - "- [x] step 2: exclude the internal .agents tree from the npm package"
  - phase: validation
    steps:
      - "- [x] step 1: verify the packed file list no longer includes release skill assets"
      - "- [ ] step 2: commit and push the fix to main"
---

# 032-remove-release-skill-from-package

## Phase 1 — Discovery
- [x] step 1: inspect the current package manifest and published files for release-related assets
- [x] step 2: confirm the source of the unwanted /release command registration

## Phase 2 — Implementation
- [x] step 1: remove skill/prompt packaging hooks so the Pi package only exposes the extension entry point
- [x] step 2: exclude the internal .agents tree from the npm package

## Phase 3 — Validation
- [x] step 1: verify the packed file list no longer includes release skill assets
- [ ] step 2: commit and push the fix to main
