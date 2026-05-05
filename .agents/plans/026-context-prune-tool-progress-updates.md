---
name: 026-context-prune-tool-progress-updates
description: Move live prune progress out of the footer details and into context_prune tool updates so agentic-auto pruning shows progress in the tool output box instead.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current footer progress wiring and context_prune tool execute/onUpdate flow"
      - "- [x] step 2: decide which progress details should stay in /pruner now overlay versus move into context_prune tool updates"
  - phase: implementation
    steps:
      - "- [x] step 1: stop showing live character details in the footer status widget while summarization is running"
      - "- [x] step 2: thread live batch-text progress into context_prune tool execution via onUpdate"
      - "- [x] step 3: format compact progress text for the context_prune tool output box while the tool is running"
      - "- [x] step 4: update docs/comments to describe the new live-progress locations"
  - phase: validation
    steps:
      - "- [x] step 1: run lightweight verification commands and review the diff"
      - "- [x] step 2: keep the plan in sync with the shipped behavior"
---

# 026-context-prune-tool-progress-updates

## Phase 1 — Discovery
- [x] step 1: inspect the current footer progress wiring and context_prune tool execute/onUpdate flow
- [x] step 2: decide which progress details should stay in /pruner now overlay versus move into context_prune tool updates

## Phase 2 — Implementation
- [x] step 1: stop showing live character details in the footer status widget while summarization is running
- [x] step 2: thread live batch-text progress into context_prune tool execution via onUpdate
- [x] step 3: format compact progress text for the context_prune tool output box while the tool is running
- [x] step 4: update docs/comments to describe the new live-progress locations

## Phase 3 — Validation
- [x] step 1: run lightweight verification commands and review the diff
- [x] step 2: keep the plan in sync with the shipped behavior
