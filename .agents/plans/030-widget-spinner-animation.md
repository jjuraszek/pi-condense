---
name: 030-widget-spinner-animation
description: Keep the /pruner now progress widget spinner animating even before summary text starts streaming.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the /pruner now widget code and identify why renders only happen on progress updates"
      - "- [x] step 2: define a minimal animation-loop approach that starts when a row begins running and stops cleanly"
  - phase: implementation
    steps:
      - "- [x] step 1: add spinner animation scheduling to the progress widget helper in src/commands.ts"
      - "- [x] step 2: ensure the loop is cleaned up when rows finish or the widget is cleared"
  - phase: validation
    steps:
      - "- [x] step 1: review the updated flow for timer leaks / stale renders"
      - "- [x] step 2: run the repo verification command and note the result"
---

# 030-widget-spinner-animation

## Phase 1 — Discovery
- [x] step 1: inspect the /pruner now widget code and identify why renders only happen on progress updates
- [x] step 2: define a minimal animation-loop approach that starts when a row begins running and stops cleanly

## Phase 2 — Implementation
- [x] step 1: add spinner animation scheduling to the progress widget helper in `src/commands.ts`
- [x] step 2: ensure the loop is cleaned up when rows finish or the widget is cleared

## Phase 3 — Validation
- [x] step 1: review the updated flow for timer leaks / stale renders
- [x] step 2: run the repo verification command and note the result (`npm run build` → `nothing to build`)
