---
name: 002-add-agent-message-prune-on-mode
description: Add a new PruneOn mode "agent-message" that flushes all pending tool call batches when the agent sends a final text message (a turn with no tool calls).
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: investigate Pi event types to understand turn_end and agent_end event data"
      - "- [x] step 2: understand how AssistantMessage.content signals a text-only vs tool-calling turn"
      - "- [x] step 3: review existing prune-on modes (every-turn, on-context-tag, on-demand) for pattern"
  - phase: implementation
    steps:
      - "- [x] step 4: add 'agent-message' to the PruneOn type union in types.ts"
      - "- [x] step 5: add 'agent-message' entry to PRUNE_ON_MODES in types.ts"
      - "- [x] step 6: update commands.ts help text, status labels, and prune-on selector with the new mode"
      - "- [x] step 7: add turn_end handler logic in index.ts to detect text-only turns and flush pending batches when pruneOn is 'agent-message'"
      - "- [x] step 8: add agent_end handler in index.ts as a safety net to flush remaining batches for 'agent-message' mode"
  - phase: validation
    steps:
      - "- [x] step 9: run TypeScript type check to confirm no compilation errors"
      - "- [x] step 10: manually verify /pruner settings shows the new mode in the selector"
      - "- [x] step 11: manually verify /pruner prune-on agent-message sets the config correctly"
---

# 002-add-agent-message-prune-on-mode

## Phase 1 — Discovery

- [x] step 1: investigate Pi event types to understand turn_end and agent_end event data
- [x] step 2: understand how AssistantMessage.content signals a text-only vs tool-calling turn
- [x] step 3: review existing prune-on modes (every-turn, on-context-tag, on-demand) for pattern

## Phase 2 — Implementation

- [x] step 4: add 'agent-message' to the PruneOn type union in types.ts
- [x] step 5: add 'agent-message' entry to PRUNE_ON_MODES in types.ts
- [x] step 6: update commands.ts help text, status labels, and prune-on selector with the new mode
- [x] step 7: add turn_end handler logic in index.ts to detect text-only turns and flush pending batches when pruneOn is 'agent-message'
- [x] step 8: add agent_end handler in index.ts as a safety net to flush remaining batches for 'agent-message' mode

## Phase 3 — Validation

- [x] step 9: run TypeScript type check to confirm no compilation errors
- [x] step 10: manually verify /pruner settings shows the new mode in the selector
- [x] step 11: manually verify /pruner prune-on agent-message sets the config correctly

---

## Design Notes

### How `agent-message` mode works

In Pi's agent loop, each user prompt triggers one or more **turns**:
1. **Tool-calling turns**: The assistant responds with tool calls → `turn_end` fires with `toolResults.length > 0`.
2. **Final text turn**: The assistant responds with text only → `turn_end` fires with `toolResults.length === 0` (or `toolResults` is an empty array). This is the "agent message" — the final answer to the user.

The new `agent-message` mode:
- Accumulates tool-calling turns into `pendingBatches` (same as `on-context-tag` mode does).
- When a **text-only turn** is detected (`turn_end` where the assistant message has no tool-call content blocks, i.e., `toolResults.length === 0`), flushes all pending batches.
- Also flushes on `agent_end` as a safety net (e.g., if the agent loop is aborted before a text-only turn).

### Detection logic

In the `turn_end` handler, the current code already checks `event.toolResults.length === 0` to skip non-tool turns. For `agent-message` mode, we flip this:
- If `event.toolResults.length > 0` → tool-calling turn → capture batch, push to `pendingBatches`, but **don't flush yet** (defer until agent sends text).
- If `event.toolResults.length === 0` → final text turn → flush all `pendingBatches`.

Additionally, we add an `agent_end` event handler that flushes any remaining `pendingBatches` when the agent loop concludes, regardless of whether a text-only turn fired.

### Key differences from existing modes

| Mode | Flush trigger |
|---|---|
| `every-turn` | After every tool-calling turn |
| `on-context-tag` | When `context_tag` tool is called |
| `on-demand` | Only when `/pruner now` is run |
| **`agent-message`** | When the agent sends a final text response (text-only turn), or on `agent_end` |

### Files to modify

1. **`src/types.ts`** — Add `"agent-message"` to `PruneOn` union and `PRUNE_ON_MODES` array.
2. **`src/commands.ts`** — Update `HELP_TEXT`, `PRUNE_ON_MODES` label (already from types.ts), status text.
3. **`index.ts`** — Modify `turn_end` handler to queue (not flush) batches when `pruneOn === "agent-message"`, add text-only turn detection, and add `agent_end` handler.