---
name: 019-toggle-prune-status-line
description: Add a user setting to show or hide the prune footer status and queued turn notifications.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current config, command UI, and turn/status update paths"
      - "- [x] step 2: identify every place that renders the prune footer or queued turn message"
  - phase: implementation
    steps:
      - "- [x] step 1: add a config field and UI controls for toggling prune status visibility"
      - "- [x] step 2: gate footer updates and queued turn notifications behind the new setting"
      - "- [x] step 3: keep persisted settings backward compatible with existing config files"
  - phase: validation
    steps:
      - "- [ ] step 1: run a build or typecheck to confirm the extension still compiles"
      - "- [x] step 2: verify the new toggle affects both footer and post-turn message behavior"
---

# 019-toggle-prune-status-line

## Phase 1 — Discovery
- [x] step 1: inspect the current config, command UI, and turn/status update paths
- [x] step 2: identify every place that renders the prune footer or queued turn message

## Phase 2 — Implementation
- [x] step 1: add a config field and UI controls for toggling prune status visibility
- [x] step 2: gate footer updates and queued turn notifications behind the new setting
- [x] step 3: keep persisted settings backward compatible with existing config files

## Phase 3 — Validation
- [ ] step 1: run a build or typecheck to confirm the extension still compiles
- [x] step 2: verify the new toggle affects both footer and post-turn message behavior

> Note: a typecheck was attempted with `npx tsc`, but the local environment does not have the Pi peer dependency type declarations installed, so a full compile confirmation is blocked here.
