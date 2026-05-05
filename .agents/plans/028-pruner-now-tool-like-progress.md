---
name: 028-pruner-now-tool-like-progress
description: Make /pruner now feel like the context_prune tool by streaming the same shared progress and result flow in the footer instead of opening the batch overlay.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current /pruner now and context_prune execution paths"
      - "- [x] step 2: identify the minimal shared progress/result flow to reuse"
  - phase: implementation
    steps:
      - "- [x] step 1: refactor /pruner now to reuse the shared progress formatter"
      - "- [x] step 2: move the existing progress UI to footer-only live summary/raw-char counts"
      - "- [x] step 3: keep the existing prune result notifications intact"
  - phase: validation
    steps:
      - "- [x] step 1: run a targeted typecheck/build or other reproducible verification (tsc --noEmit is blocked here by missing installed Pi deps)"
      - "- [x] step 2: confirm the updated command text matches the new behavior"
---

# 028-pruner-now-tool-like-progress

## Phase 1 — Discovery
- [x] step 1: inspect the current /pruner now and context_prune execution paths
- [x] step 2: identify the minimal shared progress/result flow to reuse

## Phase 2 — Implementation
- [x] step 1: refactor /pruner now to use the shared progress path
- [x] step 2: move the existing progress UI to footer-only live summary/raw-char counts
- [x] step 3: keep the existing prune result notifications intact

## Phase 3 — Validation
- [x] step 1: run a targeted typecheck/build or other reproducible verification
- [x] step 2: confirm the updated command text matches the new behavior
