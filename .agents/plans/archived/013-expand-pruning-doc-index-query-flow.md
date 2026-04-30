---
name: 013-expand-pruning-doc-index-query-flow
description: Expand PRUNING.md to explain how pruned tool results remain stored in the index and can be re-read via context_tree_query.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect PRUNING.md and relevant source files for the exact pruning/index/query behavior"
      - "- [ ] step 2: identify the best sections to clarify index persistence and on-demand re-read flow"
  - phase: implementation
    steps:
      - "- [ ] step 1: update PRUNING.md with a clearer explanation of what is pruned versus what is preserved"
      - "- [ ] step 2: add a step-by-step flow showing how the model can use toolCallIds and context_tree_query to recover raw outputs"
  - phase: validation
    steps:
      - "- [ ] step 1: review the updated doc for accuracy against the current implementation"
      - "- [ ] step 2: summarize the doc changes for the user"
---

# 013-expand-pruning-doc-index-query-flow

## Phase 1 — Discovery
- [x] step 1: inspect PRUNING.md and relevant source files for the exact pruning/index/query behavior
- [x] step 2: identify the best sections to clarify index persistence and on-demand re-read flow

## Phase 2 — Implementation
- [x] step 1: update PRUNING.md with a clearer explanation of what is pruned versus what is preserved
- [x] step 2: add a step-by-step flow showing how the model can use toolCallIds and context_tree_query to recover raw outputs

## Phase 3 — Validation
- [x] step 1: review the updated doc for accuracy against the current implementation
- [x] step 2: summarize the doc changes for the user
