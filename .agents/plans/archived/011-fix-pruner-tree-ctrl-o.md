---
name: 011-fix-pruner-tree-ctrl-o
description: Fix Ctrl-O detection in the pruner tree browser so the summary overlay opens reliably in the current Pi/TUI input setup.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current tree browser Ctrl-O handling"
      - "- [x] step 2: inspect Pi/TUI key parsing and built-in Ctrl-O bindings"
  - phase: implementation
    steps:
      - "- [x] step 1: switch tree browser Ctrl-O detection to Pi TUI key matching instead of raw byte matching"
      - "- [x] step 2: keep a legacy raw-byte fallback if needed"
  - phase: validation
    steps:
      - "- [x] step 1: review the updated input handling for both open and close paths"
      - "- [x] step 2: run a lightweight verification command"
---

# 011-fix-pruner-tree-ctrl-o

## Phase 1 — Discovery
- [x] step 1: inspect the current tree browser Ctrl-O handling
- [x] step 2: inspect Pi/TUI key parsing and built-in Ctrl-O bindings

## Phase 2 — Implementation
- [x] step 1: switch tree browser Ctrl-O detection to Pi TUI key matching instead of raw byte matching
- [x] step 2: keep a legacy raw-byte fallback if needed

## Phase 3 — Validation
- [x] step 1: review the updated input handling for both open and close paths
- [x] step 2: run a lightweight verification command
