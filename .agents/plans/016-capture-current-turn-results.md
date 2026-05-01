---
name: 016-capture-current-turn-results
description: Modify the pruning logic to capture and summarize all unindexed tool results from the session branch, including those from the current turn-in-progress, when a prune is triggered.
steps:
  - phase: research
    steps:
      - "- [x] step 1: analyze `src/batch-capture.ts` to see how it can be adapted to scan a session branch"
      - "- [x] step 2: confirm Pi's session branch structure for assistant messages and tool results"
  - phase: implementation
    steps:
      - "- [x] step 1: implement `captureUnindexedBatchesFromSession` in `src/batch-capture.ts`"
      - "- [x] step 2: refactor `flushPending` in `index.ts` to use the session scan as its primary source of truth"
      - "- [x] step 3: ensure `pendingBatches` is synchronized or replaced by the session-derived data"
      - "- [x] step 4: verify that `context_prune` housekeeping tool calls are still excluded from summarization"
  - phase: validation
    steps:
      - "- [x] step 1: manual test: run a multi-tool turn and call `context_prune` mid-turn"
      - "- [x] step 2: manual test: verify `/pruner now` catches everything unsummarized"
      - "- [x] step 3: confirm `context_tree_query` still works for results captured via the new method"
---

# 016-capture-current-turn-results

## Problem
Currently, the pruner relies on the `turn_end` event to capture "batches" of tool calls and their results. When `context_prune` is called by the agent (in `agentic-auto` mode) or when `/pruner now` is called by the user, the pruning logic only sees batches that have already been finalized by a `turn_end`.

If an agent is in the middle of a multi-tool turn (e.g., calling 5 tools followed by `context_prune`), those first 5 tool results are NOT in `pendingBatches` yet and thus are not pruned. This leaves them in context until the *next* pruning cycle, which is unexpected behavior.

## Proposed Solution
Instead of relying solely on the `pendingBatches` queue (which is tied to the `turn_end` event), the `flushPending` function should scan the current session branch for ANY tool results that have not yet been summarized (i.e., they are not in the indexer).

By walking the session tree, we can:
1. Identify all `toolResult` messages.
2. Match them back to their parent `AssistantMessage` tool calls.
3. Construct `CapturedBatch` objects for all turns (completed or in-progress) that contain unindexed results.
4. Summarize and prune them immediately.

## Phase 1 — Research
- [x] step 1: analyze `src/batch-capture.ts` to see how it can be adapted to scan a session branch
- [x] step 2: confirm Pi's session branch structure for assistant messages and tool results

## Phase 2 — Implementation
- [x] step 1: implement `captureUnindexedBatchesFromSession` in `src/batch-capture.ts`
- [x] step 2: refactor `flushPending` in `index.ts` to use the session scan as its primary source of truth
- [x] step 3: ensure `pendingBatches` is synchronized or replaced by the session-derived data
- [x] step 4: verify that `context_prune` housekeeping tool calls are still excluded from summarization

## Phase 3 — Validation
- [x] step 1: manual test: run a multi-tool turn and call `context_prune` mid-turn
- [x] step 2: manual test: verify `/pruner now` catches everything unsummarized
- [x] step 3: confirm `context_tree_query` still works for results captured via the new method
