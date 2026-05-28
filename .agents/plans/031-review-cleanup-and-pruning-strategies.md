---
name: 031-review-cleanup-and-pruning-strategies
description: Apply six review findings — fix the context_tag rename, remove dead code, add a protectedTools allowlist, add a trivial-batch skip, stub-replace pruned toolResults, and add content-hash dedup — using subagent-driven proposals reviewed before each apply.
steps:
  - phase: task-1-context-tag-rename
    steps:
      - "- [x] proposal: subagent drafts context_tag → also-accept-context_checkpoint change"
      - "- [x] review: reviewer validates proposal scope and backward compat"
      - "- [x] apply: orchestrator applies edits to index.ts, README.md, src/commands.ts, src/types.ts"
  - phase: task-2-dead-code-cleanup
    steps:
      - "- [x] proposal: subagent lists exact deletions (multi-batch-loader.ts, serializeBatchesForSummarizer, statsSuffix) and persistBatchIndex/addBatch unification"
      - "- [x] review: reviewer caught missing AGENTS.md bullet; otherwise approved"
      - "- [x] apply: orchestrator deleted files/functions, unified addBatch, refreshed AGENTS.md (incl. reviewer-flagged bullet)"
  - phase: task-3-protected-tools
    steps:
      - "- [x] proposal: subagent designs ContextPruneConfig.protectedTools wiring through capture paths and settings UI"
      - "- [x] review: APPROVED w/ two non-blocking notes (README JSON example consistency, redundant onChange save) — both applied"
      - "- [x] apply: orchestrator wired config field, both capture paths, reminder exclusion, settings overlay row, /pruner protected-tools subcommand, README + AGENTS.md"
      - "- [x] typecheck passes"
  - phase: task-4-trivial-batch-skip
    steps:
      - "- [x] proposal: subagent specifies minBatchChars=1000 default, new skipped-trivial outcome, pre-flush filter with index-aligned results"
      - "- [x] review: APPROVED w/ note about missing DEFAULT_CONFIG import — added during apply"
      - "- [x] apply: wired types, config normalize, index.ts pre-flush + result loop + frontier outcome + notifications, commands.ts SettingsList + subcommand + HELP_TEXT, context-prune-tool, README, AGENTS.md"
      - "- [x] typecheck passes"
  - phase: task-5-stub-replace-pruned-toolresults
    steps:
      - "- [x] proposal: subagent rewrites pruner.ts to return {messages, pruned}; adds toolCallIdToAlias reverse map + getShortRefForToolCallId helper"
      - "- [x] review: APPROVED unconditionally; reviewer confirmed pi-ai insertSyntheticToolResults no-op, legacy entry fallback, cache stability"
      - "- [x] apply: indexer reverse map, pruner.ts rewrite, index.ts context-handler adapter, AGENTS.md, README.md, PRUNING.md"
      - "- [x] typecheck passes"
  - phase: task-6-content-hash-dedup
    steps:
      - "- [x] proposal: SHA-1 (toolName, normalized resultText), new CUSTOM_TYPE_DEDUP_ALIAS, alias reuses original short ref, cross-flush v1 only"
      - "- [x] review: CHANGES_REQUIRED w/ B1 + B2 (FlushResult unions in commands.ts and context-prune-tool.ts) + N1 (overlap in index.ts) — all addressed during apply"
      - "- [x] apply: types, content-hash.ts (new), indexer.ts (maps + lookup + registerDuplicate + reconstruct), config, index.ts (dedup pre-flush + result loop + frontier + notifications + return), commands.ts (incl. B2 fix), context-prune-tool.ts (incl. B1 fix), README, AGENTS.md, PRUNING.md"
      - "- [x] typecheck passes"
  - phase: verification
    steps:
      - "- [x] typecheck (bun x tsc) clean after each task"
      - "- [x] AGENTS.md Code Structure section reflects all six changes"
      - "- [x] no stale references to removed code (multi-batch-loader, serializeBatchesForSummarizer, statsSuffix)"
---

# 031-review-cleanup-and-pruning-strategies

## Phase 1 — Task 1: context_tag rename fix
- [x] proposal: subagent drafts context_tag → also-accept-context_checkpoint change
- [x] review: reviewer validates proposal scope and backward compat
- [x] apply: orchestrator applies edits to index.ts, README.md, src/commands.ts, src/types.ts

## Phase 2 — Task 2: dead-code cleanup
- [x] proposal: subagent lists exact deletions and unification plan
- [x] review: reviewer caught missing AGENTS.md bullet; otherwise approved
- [x] apply: orchestrator deleted files/functions, unified addBatch, refreshed AGENTS.md (incl. reviewer-flagged bullet)

## Phase 3 — Task 3: protectedTools allowlist
- [x] proposal: subagent designs ContextPruneConfig.protectedTools wiring
- [x] review: APPROVED w/ two non-blocking notes — both applied
- [x] apply: orchestrator wired config field, both capture paths, reminder exclusion, settings overlay row, /pruner protected-tools subcommand, README + AGENTS.md
- [x] typecheck passes

## Phase 4 — Task 4: trivial-batch skip
- [x] proposal: subagent specifies minBatchChars=1000 default, new skipped-trivial outcome
- [x] review: APPROVED w/ note about missing DEFAULT_CONFIG import — added during apply
- [x] apply: types, config, index.ts (pre-flush + result loop + frontier + notifications), commands.ts, context-prune-tool, README, AGENTS.md
- [x] typecheck passes

## Phase 5 — Task 5: stub-replace pruned toolResults
- [x] proposal: subagent designs stub format, reverse-map lookup, return-shape change
- [x] review: APPROVED unconditionally
- [x] apply: indexer, pruner.ts, index.ts context handler, AGENTS.md, README.md, PRUNING.md
- [x] typecheck passes

## Phase 6 — Task 6: content-hash dedup
- [x] proposal: SHA-1, CUSTOM_TYPE_DEDUP_ALIAS, alias reuses original short ref, cross-flush v1
- [x] review: CHANGES_REQUIRED on FlushResult unions — fixed during apply
- [x] apply: types, content-hash.ts (new), indexer, config, index.ts, commands.ts, context-prune-tool.ts, README, AGENTS.md, PRUNING.md
- [x] typecheck passes

## Phase 7 — Verification
- [x] typecheck (bun x tsc) clean after each task
- [x] AGENTS.md Code Structure section reflects all six changes
- [x] no stale references to removed code
