---
name: 009-investigate-pruner-now-during-streaming
description: Determine whether /pruner now can run while the agent is streaming and what pending batches it will prune.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the extension event flow around pendingBatches and flushPending"
      - "- [x] step 2: inspect the /pruner now command handler"
      - "- [x] step 3: inspect Pi docs for extension command behavior during streaming"
  - phase: analysis
    steps:
      - "- [x] step 1: trace which tool results reach pendingBatches before and during an active turn"
      - "- [x] step 2: identify whether flushPending races with turn_end or only drains completed batches"
  - phase: validation
    steps:
      - "- [x] step 1: summarize the practical behavior and edge cases for the user"
---

# 009-investigate-pruner-now-during-streaming

## Phase 1 — Discovery
- [x] step 1: inspect the extension event flow around pendingBatches and flushPending
- [x] step 2: inspect the /pruner now command handler
- [x] step 3: inspect Pi docs for extension command behavior during streaming

## Phase 2 — Analysis
- [x] step 1: trace which tool results reach pendingBatches before and during an active turn
- [x] step 2: identify whether flushPending races with turn_end or only drains completed batches

## Phase 3 — Validation
- [x] step 1: summarize the practical behavior and edge cases for the user
