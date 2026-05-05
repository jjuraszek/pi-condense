---
name: 023-streaming-summarizer-char-progress
description: Show live received-character progress in the /pruner now summarizer overlay while a batch summary streams in.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: confirm the current summarizer and overlay flow and find a streaming API that exposes text deltas"
      - "- [x] step 2: decide where to thread progress callbacks so only the interactive overlay pays for live updates"
  - phase: implementation
    steps:
      - "- [x] step 1: add summarizer-side streaming progress callbacks and keep the existing non-streaming behavior intact when unused"
      - "- [x] step 2: update the multi-batch overlay to render received-character counts while a batch is still summarizing"
      - "- [x] step 3: wire /pruner now flush progress into the overlay so character counts update live"
      - "- [x] step 4: update docs/comments that describe the summarizer and /pruner now progress behavior"
  - phase: validation
    steps:
      - "- [x] step 1: run a repo check or targeted verification command"
      - "- [x] step 2: review the changed files for consistency and mark the plan complete"
---

# 023-streaming-summarizer-char-progress

## Phase 1 — Discovery
- [x] step 1: confirm the current summarizer and overlay flow and find a streaming API that exposes text deltas
- [x] step 2: decide where to thread progress callbacks so only the interactive overlay pays for live updates

## Phase 2 — Implementation
- [x] step 1: add summarizer-side streaming progress callbacks and keep the existing non-streaming behavior intact when unused
- [x] step 2: update the multi-batch overlay to render received-character counts while a batch is still summarizing
- [x] step 3: wire /pruner now flush progress into the overlay so character counts update live
- [x] step 4: update docs/comments that describe the summarizer and /pruner now progress behavior

## Phase 3 — Validation
- [x] step 1: run a repo check or targeted verification command
- [x] step 2: review the changed files for consistency and mark the plan complete
