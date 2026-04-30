---
name: 003-add-agentic-auto-prune-mode
description: Add a new PruneOn mode "agentic-auto" where the LLM agent decides when to prune by calling a context_prune tool. The tool is only injected when this mode is active, and a system prompt instructs the model on when to use it.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: review existing Pi extension API for registerTool, setActiveTools, sendMessage, and before_agent_start to understand tool injection patterns"
      - "- [x] step 2: review how context_tree_query tool is registered and how its promptSnippet/promptGuidelines work"
      - "- [x] step 3: review how the before_agent_start event exposes systemPrompt for understanding injection points"
  - phase: types-and-config
    steps:
      - "- [x] step 4: add 'agentic-auto' to the PruneOn type union in src/types.ts"
      - "- [x] step 5: add 'agentic-auto' entry to PRUNE_ON_MODES array in src/types.ts with label 'Agentic auto'"
      - "- [x] step 6: add AGENTIC_AUTO_SYSTEM_PROMPT constant to src/types.ts containing the instructions for when to use context_prune"
  - phase: context-prune-tool
    steps:
      - "- [x] step 7: create src/context-prune-tool.ts with the context_prune tool registration function"
      - "- [x] step 8: implement tool execute handler that flushes all pending batches via summarizer + indexer, then returns a confirmation message"
      - "- [x] step 9: add promptSnippet and promptGuidelines to the tool definition so the LLM knows the tool exists and when to use it"
  - phase: system-prompt-injection
    steps:
      - "- [x] step 10: register a before_agent_start event handler that appends the agentic-auto system prompt when pruneOn === 'agentic-auto'"
  - phase: index-integration
    steps:
      - "- [x] step 11: wire the context_prune tool into index.ts — register it always but conditionally activate/deactivate based on config"
      - "- [x] step 12: in session_start handler, call setActiveTools to add context_prune when agentic-auto mode is active, or remove it otherwise"
      - "- [x] step 13: in the /pruner on/off/prune-on handlers, update active tools when switching to/from agentic-auto mode"
      - "- [x] step 14: modify turn_end handler — in agentic-auto mode, capture batches into pendingBatches but do NOT auto-flush (similar to on-demand)"
  - phase: commands
    steps:
      - "- [x] step 15: update HELP_TEXT in commands.ts to document agentic-auto mode"
      - "- [x] step 16: ensure /pruner settings overlay includes agentic-auto in the prune-on selector"
  - phase: validation
    steps:
      - "- [ ] step 17: run TypeScript type check to confirm no compilation errors"
      - "- [ ] step 18: manually verify /pruner settings shows agentic-auto mode"
      - "- [ ] step 19: manually verify that switching to agentic-auto activates the context_prune tool"
      - "- [ ] step 20: manually verify the context_prune tool appears in the LLM's available tools and the system prompt includes instructions"
---

# 003-add-agentic-auto-prune-mode

## Phase 1 — Discovery

- [x] step 1: review existing Pi extension API for registerTool, setActiveTools, sendMessage, and before_agent_start to understand tool injection patterns
- [x] step 2: review how context_tree_query tool is registered and how its promptSnippet/promptGuidelines work
- [x] step 3: review how the before_agent_start event exposes systemPrompt for understanding injection points

## Phase 2 — Types and Config

- [x] step 4: add 'agentic-auto' to the PruneOn type union in `src/types.ts`
- [x] step 5: add 'agentic-auto' entry to `PRUNE_ON_MODES` array in `src/types.ts` with label 'Agentic auto'
- [x] step 6: add `AGENTIC_AUTO_SYSTEM_PROMPT` constant to `src/types.ts` containing the instructions for when to use `context_prune`

## Phase 3 — context_prune Tool

- [x] step 7: create `src/context-prune-tool.ts` with the `context_prune` tool registration function
- [x] step 8: implement tool execute handler that flushes all pending batches via summarizer + indexer, then returns a confirmation message
- [x] step 9: add `promptSnippet` and `promptGuidelines` to the tool definition so the LLM knows the tool exists and when to use it

## Phase 4 — System Prompt Injection

- [x] step 10: register a `before_agent_start` event handler that appends the agentic-auto system prompt when `pruneOn === "agentic-auto"`

## Phase 5 — Index Integration

- [x] step 11: wire the `context_prune` tool into `index.ts` — register it always but conditionally activate/deactivate based on config
- [x] step 12: in `session_start` handler, call `setActiveTools` to add `context_prune` when agentic-auto mode is active, or remove it otherwise
- [x] step 13: in the `/pruner on/off/prune-on` handlers, update active tools when switching to/from agentic-auto mode
- [x] step 14: modify `turn_end` handler — in agentic-auto mode, capture batches into `pendingBatches` but do NOT auto-flush (similar to on-demand)

## Phase 6 — Commands

- [x] step 15: update `HELP_TEXT` in `commands.ts` to document agentic-auto mode
- [x] step 16: ensure `/pruner settings` overlay includes agentic-auto in the prune-on selector

## Phase 7 — Validation

- [ ] step 17: run TypeScript type check to confirm no compilation errors
- [ ] step 18: manually verify `/pruner settings` shows agentic-auto mode
- [ ] step 19: manually verify that switching to agentic-auto activates the `context_prune` tool
- [ ] step 20: manually verify the `context_prune` tool appears in the LLM's available tools and the system prompt includes instructions

---

## Design Notes

### How `agentic-auto` mode works

Unlike the existing modes (`every-turn`, `on-context-tag`, `on-demand`, `agent-message`) which are **user-driven** or **event-driven**, `agentic-auto` lets the **LLM agent itself** decide when to prune.

**Flow:**
1. Tool calls are captured into `pendingBatches` on every `turn_end` (same as `on-demand` and `on-context-tag`).
2. The `context_prune` tool is **only active** when `pruneOn === "agentic-auto"`. It is always registered but toggled via `setActiveTools`.
3. When the LLM calls `context_prune`, the tool's execute handler calls `flushPending` — summarizing all pending batches, indexing them, and injecting steer messages.
4. A `before_agent_start` event handler injects a system prompt addendum explaining when to use the tool (after 8–10 related tool calls, not after every 2–3 calls).

### The `context_prune` tool

| Field | Value |
|---|---|
| `name` | `context_prune` |
| `label` | "Prune Context" |
| `description` | Summarize and prune preceding tool-call results from context. Call after a batch of related tool calls to keep context lean. |
| `promptSnippet` | "Summarize and prune preceding tool-call results to reduce context size" |
| `promptGuidelines` | ["Use after completing a batch of 8-10 related tool calls (not after every 2-3 calls).", "Pruned outputs can be recovered in full using context_tree_query.", "Do NOT use this tool for trivial operations — only when context is getting large."] |
| `parameters` | `{}` (empty object — no parameters needed) |
| `execute` | Calls `flushPending(ctx)` → returns confirmation with count of summarized tool calls |

### System prompt for agentic-auto mode

The `before_agent_start` handler will inject an additional instruction block when `pruneOn === "agentic-auto"`:

```
[Context Prune — Agentic Auto Mode]
You have access to the context_prune tool. Use it to summarize and compact preceding tool-call results when:
- You have completed a group of 8-10 related tool calls (e.g., a multi-step file edit, search, or analysis sequence).
- The context is getting large and you want to keep it manageable.
- Do NOT call context_prune after every 2-3 tool calls — only after a meaningful batch is done.

When context_prune is called, all pending tool-call results are summarized and replaced with concise bullet points. The original full outputs are preserved and can be retrieved at any time using context_tree_query with the toolCallIds listed in the summary.
```

### Tool activation strategy

The `context_prune` tool is **always registered** via `pi.registerTool()` at startup (so Pi knows about it), but its **active state** is toggled:

- On `session_start`: if `pruneOn === "agentic-auto"`, add `"context_prune"` to the active tools list via `ctx.setActiveTools()`.
- On `/pruner prune-on agentic-auto`: add the tool. On `/pruner prune-on <other>` or `/pruner off`: remove it.
- On `/pruner on` (with `pruneOn === "agentic-auto"`): add the tool. On `/pruner off`: remove it.

### Differences from other modes

| Mode | Flush trigger | Who decides |
|---|---|---|
| `every-turn` | After every tool-calling turn | Automatic |
| `on-context-tag` | When `context_tag` is called | Automatic (on tag) |
| `on-demand` | When user runs `/pruner now` | User |
| `agent-message` | When agent sends final text response | Automatic (on text turn) |
| **`agentic-auto`** | When LLM calls `context_prune` tool | **LLM agent** |

### Files to modify

1. **`src/types.ts`** — Add `"agentic-auto"` to `PruneOn`, add to `PRUNE_ON_MODES`, add `AGENTIC_AUTO_SYSTEM_PROMPT` constant.
2. **`src/context-prune-tool.ts`** — New file: the `context_prune` tool definition + registration function.
3. **`index.ts`** — Wire the tool, add `before_agent_start` handler for system prompt injection, modify `turn_end` handler for agentic-auto mode (queue but don't auto-flush), update `session_start` and command handlers to toggle tool activation.
4. **`src/commands.ts`** — Update `HELP_TEXT`, `PRUNE_ON_MODES` (picks up from types), and prune-on/on/off handlers to toggle `context_prune` tool.