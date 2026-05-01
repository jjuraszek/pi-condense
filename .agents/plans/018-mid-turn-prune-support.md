---
name: 018-mid-turn-prune-support
description: Allow pruning intermediate completed tool-call subsets inside a long agent tool chain without losing later tool calls from the same turn.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect capture and frontier handling for mid-turn pruning"
      - "- [x] step 2: identify how later tool calls in the same turn are currently skipped"
  - phase: implementation
    steps:
      - "- [x] step 1: restrict session-captured batches to tool calls with actual results"
      - "- [x] step 2: trim batches against the prune frontier instead of skipping whole same-turn batches"
      - "- [x] step 3: apply the same trimming logic to both session-scan and turn_end capture paths"
      - "- [x] step 4: update docs/comments to reflect mid-turn prune behavior"
  - phase: validation
    steps:
      - "- [x] step 1: inspect the changed control flow for the target scenario"
      - "- [x] step 2: run an available repo verification command"
---

# 018-mid-turn-prune-support

## Phase 1 — Discovery
- [x] step 1: inspect capture and frontier handling for mid-turn pruning
- [x] step 2: identify how later tool calls in the same turn are currently skipped

## Phase 2 — Implementation
- [x] step 1: restrict session-captured batches to tool calls with actual results
- [x] step 2: trim batches against the prune frontier instead of skipping whole same-turn batches
- [x] step 3: apply the same trimming logic to both session-scan and turn_end capture paths
- [x] step 4: update docs/comments to reflect mid-turn prune behavior

## Phase 3 — Validation
- [x] step 1: inspect the changed control flow for the target scenario
- [x] step 2: run an available repo verification command
