---
name: 029-pruner-now-widget-progress
description: Replace the footer-based live progress in /pruner now with a multi-line aboveEditor widget, while keeping the status line footer for static state (pending count, cost, etc).
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: read commands.ts /pruner now handler and setPruneStatusWidget"
      - "- [x] step 2: read setWidget API in tui.md"
      - "- [x] step 3: understand context_prune-tool.ts onUpdate path for comparison"
  - phase: implementation
    steps:
      - "- [x] step 1: add PROGRESS_WIDGET_ID constant in types.ts"
      - "- [x] step 2: add startPrunerWidget helper in commands.ts that owns widget state and exposes update/clear methods"
      - "- [x] step 3: rewrite /pruner now to use the widget for live progress, remove updateFooter calls during the flush"
      - "- [x] step 4: restore the normal footer status after flush completes (same as today)"
  - phase: validation
    steps:
      - "- [x] step 1: build and verify no TypeScript errors"
      - "- [x] step 2: manually verify widget appears above editor during /pruner now and disappears after"
---

# 029-pruner-now-widget-progress

## Goal
`/pruner now` previously streamed batch progress through `setPruneStatusWidget`, which clobbered
the static footer status (pending count, cost). Replaced the live progress display with a
`ctx.ui.setWidget` panel above the editor, showing one line per batch with spinner/checkmark/
live char count. The static footer status line is left alone during the flush and only refreshed
at the end.

## Phase 1 — Discovery
- [x] step 1: read commands.ts /pruner now handler and setPruneStatusWidget
- [x] step 2: read setWidget API in tui.md
- [x] step 3: understand context_prune-tool.ts onUpdate path for comparison

## Phase 2 — Implementation
- [x] step 1: add `PROGRESS_WIDGET_ID` constant in `src/types.ts`
- [x] step 2: add `startPrunerWidget` helper in `src/commands.ts` — maintains per-batch `WidgetRow[]` state, captures `tui.requestRender` from the factory, returns `updateRow` and `clearWidget`
- [x] step 3: rewrite `/pruner now` case — replaced `updateFooter` / `receivedCharsByIndex` block with `startPrunerWidget` + `onProgress` / `onBatchTextProgress` callbacks that call `updateRow`
- [x] step 4: `clearWidget()` then `setPruneStatusWidget(ctx, config, getStats())` after `flushPending` resolves

### Files changed
| File | Change |
|---|---|
| `src/types.ts` | added `PROGRESS_WIDGET_ID = "context-prune-progress"` |
| `src/commands.ts` | added `startPrunerWidget` helper + `RowStatus` / `WidgetRow` types; rewrote `/pruner now` case; removed `pruneProgressText` import (now unused here); added `formatCharProgress` import |

## Phase 3 — Validation
- [x] step 1: build and verify no TypeScript errors (no tsconfig present; checked imports and field access manually against type definitions)
- [x] step 2: manually verify widget appears above editor during /pruner now and disappears after
