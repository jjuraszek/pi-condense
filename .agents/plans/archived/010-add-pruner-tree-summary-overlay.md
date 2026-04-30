---
name: 010-add-pruner-tree-summary-overlay
description: Add a Ctrl-O shortcut in the /pruner tree browser to open the selected pruned summary message in a bordered overlay dialog.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the existing /pruner tree browser implementation and how summary content is stored on nodes"
      - "- [x] step 2: identify the simplest way to render a modal-style overlay inside the current tree browser component"
  - phase: implementation
    steps:
      - "- [x] step 1: add summary viewer state and Ctrl-O handling to the tree browser"
      - "- [x] step 2: render a bordered overlay on top of the tree with the selected summary message content"
      - "- [x] step 3: update visible help text so the new shortcut is discoverable"
  - phase: validation
    steps:
      - "- [x] step 1: review the updated tree browser behavior for summary and non-summary selections"
      - "- [x] step 2: run a lightweight verification command"
---

# 010-add-pruner-tree-summary-overlay

## Phase 1 — Discovery
- [x] step 1: inspect the existing /pruner tree browser implementation and how summary content is stored on nodes
- [x] step 2: identify the simplest way to render a modal-style overlay inside the current tree browser component

## Phase 2 — Implementation
- [x] step 1: add summary viewer state and Ctrl-O handling to the tree browser
- [x] step 2: render a bordered overlay on top of the tree with the selected summary message content
- [x] step 3: update visible help text so the new shortcut is discoverable

## Phase 3 — Validation
- [x] step 1: review the updated tree browser behavior for summary and non-summary selections
- [x] step 2: run a lightweight verification command
