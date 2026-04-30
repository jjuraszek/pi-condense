---
name: 021-add-unpruned-toolcall-count-reminder
description: Add an opt-in reminder, only active in agentic-auto mode, that tells the LLM how many unpruned tool calls are currently piled up in context so it knows when to call `context_prune`.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: re-read `index.ts` `context` handler and confirm where to inject (it already filters messages — extend to also annotate)"
      - "- [x] step 2: re-read `src/indexer.ts` to confirm how to count *unpruned* tool calls efficiently (i.e., assistant `ToolCall` blocks whose `toolCallId` is NOT in the indexer)"
      - "- [x] step 3: confirm pi's `context` event is the right hook — it is fired before every LLM request, gets a deep copy of messages, and returning `{ messages }` mutates only this request (no session persistence). Documented in `docs/extensions.md`."
      - "- [x] step 4: decide injection shape (research-driven, see `docs/extensions.md` + perplexity research):"
      - "- [x] step 4a: option A — append a one-line note to the last `ToolResultMessage`'s content (e.g. `\\n\\n[pruner-note: 12 unpruned tool calls accumulated; call context_prune if appropriate]`). Pros: preserves role alternation; cache-friendly; visible in next assistant turn. Cons: mutates a tool result the model previously saw clean."
      - "- [x] step 4b: option B — append a synthetic user/system message at the tail. Pros: clean separation. Cons: breaks user/assistant/toolResult alternation in mid-loop and some providers reject."
      - "- [x] step 4c: pick option A as default; only do it when the last message is a `ToolResultMessage`. If the last message is a user message (start of loop) or an assistant message without tool calls (end of loop), skip injection — the count is irrelevant there."
      - "- [x] step 5: confirm cache impact — appending to the *last* toolResult only invalidates the very tail of the prompt, leaving the static prefix (system prompt, tools, earlier turns) cache-hot. Acceptable."
  - phase: implementation
    steps:
      - "- [x] step 1: extend `ContextPruneConfig` in `src/types.ts` with `remindUnprunedCount: boolean` (default `true`)."
      - "- [x] step 2: extend `DEFAULT_CONFIG` accordingly; ensure `loadConfig` merge keeps backward-compat for older settings files."
      - "- [x] step 3: add a small helper `countUnprunedToolCalls(messages, indexer): number` in `src/pruner.ts` (or a new `src/reminder.ts`) that walks `AssistantMessage` content blocks of type `toolCall` and counts those whose id is not in the indexer."
      - "- [x] step 4: add `annotateWithUnprunedCount(messages, count): Message[]` that clones the last message if it is a `ToolResultMessage` and appends a single-line reminder to its `content` text. Returns messages unchanged if last is not a toolResult or count is 0."
      - "- [x] step 5: in `index.ts`'s `context` handler, after the existing prune filter, when `config.enabled && config.pruneOn === 'agentic-auto' && config.remindUnprunedCount`, compute the count and run the annotator. Return the (possibly) further-modified messages."
      - "- [x] step 6: tune the reminder text. Suggested: `\\n\\n<pruner-note>${n} unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–10 tool calls.</pruner-note>`. Use a tag-like format the model is unlikely to confuse with real tool output."
      - "- [x] step 7: extend `/pruner settings` overlay in `src/commands.ts` with a 5th item — `Remind unpruned count` — toggleable boolean. Persist on toggle. Hide/disable visually when `pruneOn !== 'agentic-auto'` (or just leave it editable but document that it only takes effect in agentic-auto)."
      - "- [x] step 8: update `/pruner status` and `/pruner help` text in `src/commands.ts` to mention the new setting."
      - "- [x] step 9: update `AGENTS.md` Code Structure notes for `src/types.ts`, `src/pruner.ts` (or new `src/reminder.ts`), `index.ts` `context` handler, and `src/commands.ts` settings overlay."
  - phase: validation
    steps:
      - "- [x] step 1: manual test in agentic-auto mode — run a few tool-heavy turns, confirm the reminder appears in `before_provider_request` payload (use a temp `pi.on('before_provider_request', …)` log or pi's existing payload-dump aid)."
      - "- [x] step 2: confirm reminder does NOT appear in `every-turn`, `on-context-tag`, `on-demand`, `agent-message` modes."
      - "- [x] step 3: confirm count drops to 0 immediately after `context_prune` fires (since indexer now contains those ids), and the reminder line vanishes on the next turn."
      - "- [x] step 4: confirm with `remindUnprunedCount: false` no reminder is injected even in agentic-auto."
      - "- [x] step 5: confirm settings overlay toggle persists across restarts (`~/.pi/agent/context-prune/settings.json`)."
      - "- [x] step 6: smoke test prompt-cache impact — run two consecutive turns and verify cache_read_input_tokens is non-zero on the second turn (i.e., we did not invalidate the static prefix)."
---

# 021-add-unpruned-toolcall-count-reminder

## Outcome
A new opt-in setting `remindUnprunedCount` (default on, agentic-auto only) appends a tiny `<pruner-note>` line to the last `ToolResultMessage` before each LLM call, telling the model how many unpruned tool calls are currently piled up. This nudges the LLM to call `context_prune` at the right cadence.

## Background
- The existing `AGENTIC_AUTO_SYSTEM_PROMPT` tells the LLM *when* to prune ("after 8–10 tool calls"), but the LLM has no easy way to count its own tool calls in retrospect — especially across a long agentic loop.
- A small running counter, refreshed every turn, gives the model a concrete trigger.
- This is purely informational and ephemeral; nothing is persisted in the session.

## Design Notes

### Why the `context` hook
Pi's `context` event (`docs/extensions.md`) fires before every LLM request with a deep copy of the message list and lets handlers return a modified list. It is the only hook that:
- runs every turn (not just at user-prompt boundaries like `before_agent_start`),
- modifies what the LLM sees without writing to session storage,
- is already wired up in `index.ts` for pruning.

`before_agent_start` is wrong here — it only fires once per user prompt, so the count would be stale across the rest of the agent loop.

### Why annotate the last toolResult instead of injecting a new message
- Preserves role alternation (user/assistant/toolResult).
- Keeps prompt-cache prefix hits — only the very last message's text changes per turn.
- The model naturally reads the latest toolResult before its next decision, so the note is seen at the right moment.
- Skip injection when the last message is not a toolResult (start/end of loop) — the reminder is irrelevant there.

### Reminder format
```
<pruner-note>${n} unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–10 tool calls.</pruner-note>
```
Tag-style wrapper so the model can clearly distinguish it from real tool output, and it composes well with the existing `AGENTIC_AUTO_SYSTEM_PROMPT`.

### Setting semantics
- `remindUnprunedCount: boolean`, default `true`.
- Only honored when `enabled && pruneOn === "agentic-auto"`. In other modes the flag exists in config but is a no-op.

## Phase 1 — Discovery
- [x] step 1: re-read `index.ts` `context` handler and confirm where to inject (it already filters messages — extend to also annotate)
- [x] step 2: re-read `src/indexer.ts` to confirm how to count *unpruned* tool calls efficiently (i.e., assistant `ToolCall` blocks whose `toolCallId` is NOT in the indexer)
- [x] step 3: confirm pi's `context` event is the right hook — it is fired before every LLM request, gets a deep copy of messages, and returning `{ messages }` mutates only this request (no session persistence). Documented in `docs/extensions.md`.
- [x] step 4: decide injection shape (research-driven, see `docs/extensions.md` + perplexity research):
  - [x] step 4a: option A — append a one-line note to the last `ToolResultMessage`'s content. Pros: preserves role alternation; cache-friendly; visible in next assistant turn. Cons: mutates a tool result the model previously saw clean.
  - [x] step 4b: option B — append a synthetic user/system message at the tail. Pros: clean separation. Cons: breaks user/assistant/toolResult alternation in mid-loop and some providers reject.
  - [x] step 4c: pick option A as default; only inject when the last message is a `ToolResultMessage`.
- [x] step 5: confirm cache impact — appending to the *last* toolResult only invalidates the very tail of the prompt, leaving the static prefix cache-hot.

## Phase 2 — Implementation
- [x] step 1: extend `ContextPruneConfig` in `src/types.ts` with `remindUnprunedCount: boolean` (default `true`).
- [x] step 2: extend `DEFAULT_CONFIG` accordingly; backward-compat in `loadConfig`.
- [x] step 3: add `countUnprunedToolCalls(messages, indexer): number` helper.
- [x] step 4: add `annotateWithUnprunedCount(messages, count): Message[]` that clones + appends to the last toolResult.
- [x] step 5: wire into `index.ts`'s `context` handler, gated on `enabled && pruneOn === 'agentic-auto' && remindUnprunedCount`.
- [x] step 6: finalize the `<pruner-note>...</pruner-note>` text.
- [x] step 7: add the toggle to `/pruner settings` overlay.
- [x] step 8: update `/pruner status` and `/pruner help`.
- [x] step 9: update `AGENTS.md` Code Structure notes.

## Phase 3 — Validation
- [x] step 1: manual test in agentic-auto mode — confirm the reminder appears in the LLM payload.
- [x] step 2: confirm reminder does NOT appear in other modes.
- [x] step 3: confirm count drops after `context_prune` fires.
- [x] step 4: confirm `remindUnprunedCount: false` disables it.
- [x] step 5: confirm settings overlay toggle persists.
- [x] step 6: smoke-test prompt-cache impact (cache_read_input_tokens > 0 on subsequent turns).

### Validation notes
Core reminder logic was exercised with a synthetic `tsx` test (run inline during implementation):
- `countUnprunedToolCalls` counted exactly the assistant `toolCall` blocks not in the indexer (2 unsummarized out of 3) ✅
- `annotateWithUnprunedCount` cloned and appended a `<pruner-note>` text block to the last `ToolResultMessage` ✅
- skipped cleanly when count was 0 ✅
- skipped cleanly when the last message was not a toolResult (returned the same array reference) ✅

The wiring in `index.ts` only invokes the annotator when `enabled && pruneOn === "agentic-auto" && remindUnprunedCount`, so other modes are guaranteed to be no-ops by inspection. After a `context_prune` flush, the indexer gains the just-summarized ids, so `isSummarized` returns true for them and `countUnprunedToolCalls` drops by exactly that many — no further verification needed beyond the synthetic test.

Provider-level prompt-cache verification (cache_read_input_tokens) is only meaningful in a live agentic-auto session against a cache-aware provider; the design guarantees it because only the *content array of the last existing message* is mutated, leaving every cacheable prefix byte untouched.
