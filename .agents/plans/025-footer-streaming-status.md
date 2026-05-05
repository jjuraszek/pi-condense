---
name: 025-footer-streaming-status
description: Extend summarizer streaming progress so the footer status line also shows compact received-character progress during pruning, including agentic-auto context_prune runs.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current flushPending status updates and summarizer batch APIs to find the right hook for footer progress"
      - "- [x] step 2: decide how compact character progress should be formatted for single-batch and multi-batch pruning"
  - phase: implementation
    steps:
      - "- [x] step 1: add shared compact-count formatting and reuse it in the /pruner now overlay"
      - "- [x] step 2: thread streaming batch-text progress through parallel and sequential summarization paths"
      - "- [x] step 3: update flushPending so the footer status widget shows live compact character progress for both manual and agentic-auto pruning"
      - "- [x] step 4: refresh docs/comments to describe the footer progress behavior"
  - phase: validation
    steps:
      - "- [x] step 1: run lightweight verification commands and review the final diff"
      - "- [x] step 2: commit the changes with a clear message and push main"
---

# 025-footer-streaming-status

## Phase 1 — Discovery
- [x] step 1: inspect the current flushPending status updates and summarizer batch APIs to find the right hook for footer progress
- [x] step 2: decide how compact character progress should be formatted for single-batch and multi-batch pruning

## Phase 2 — Implementation
- [x] step 1: add shared compact-count formatting and reuse it in the /pruner now overlay
- [x] step 2: thread streaming batch-text progress through parallel and sequential summarization paths
- [x] step 3: update flushPending so the footer status widget shows live compact character progress for both manual and agentic-auto pruning
- [x] step 4: refresh docs/comments to describe the footer progress behavior

## Phase 3 — Validation
- [x] step 1: run lightweight verification commands and review the final diff
- [x] step 2: commit the changes with a clear message and push main
