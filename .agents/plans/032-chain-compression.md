---
name: 032-chain-compression
description: |
  Add DCP-style range compression on top of the existing per-batch stub pruner. When a closed agent chain falls outside a rolling window of K=3 most-recent closed chains, the chain's middle messages (assistant turns with thinking + toolCalls + their matching toolResults) are dropped from LLM context and replaced in-place with a synthetic user message wrapping the existing per-batch summary text in `<compressed-chain id="b1" tools="t3,t4,t5">…</compressed-chain>`. The chain's starting user message stays raw; the chain's final text-only assistant stays raw with its thinking block stripped (safe — no following tool cycle depends on its signature). Per-batch tool-result stub pruner is unchanged and continues to handle live + recent chains. Zero new LLM calls in phase 1: chain summary text is the existing `context-prune-summary` entry, referenced by message ID. Persistence via new `context-prune-chain` custom entry, rebuilt on `session_start`. On by default. New slash command `/pruner compact` for on-demand retroactive compression. Phase 2 adds nested-summary placeholders (`{b1}` substitution so later chain summaries can fold earlier blocks) and a `purgeErrors` strategy that replaces failed toolCall argument bodies with stubs after a configurable cooldown. Cross-model thinking-signature stripping is **not** in scope — pi-ai's `transformMessages` already handles it via `isSameModel` checks.
steps:
  - phase: task-1-types-chain-detector-block-refs
    steps:
      - "- [ ] proposal: subagent designs ChainCompressionEntry / ChainRange / CUSTOM_TYPE_CHAIN / ChainCompressionConfig types in src/types.ts, the chain-detector state-machine (with synthetic-message passthrough + open-chain skip), and block-refs issuer + rebuild logic; lists exact bun:test cases for both pure modules; lists the package.json `test` script + tsconfig changes needed for bun:test"
      - "- [ ] review: reviewer validates type field names match Section 4 of this plan, state-machine covers Section 9 edge cases, test list covers ordering invariant + synthetic-passthrough + open-chain-skip + rebuild-from-gapped-sequence"
      - "- [ ] apply: orchestrator adds types, src/chain-detector.ts, src/chain-detector.test.ts, src/block-refs.ts, src/block-refs.test.ts, package.json test script, AGENTS.md custom-entry table row"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-detector.test.ts src/block-refs.test.ts` green"
  - phase: task-2-chain-range-prune
    steps:
      - "- [ ] proposal: subagent designs the pure applyChainCompressions(...) per Section 5, withoutThinkingBlocks helper, buildSyntheticChainMessage helper (F2 format), and the test suite covering ordering invariant + insert position + drop-by-id + summary suppression + thinking strip + idempotency"
      - "- [ ] review: reviewer validates the synthetic message ID scheme is deterministic, F2 XML wrapping is exact, ordering invariant test is robust (e.g. uses non-trivial input permutations)"
      - "- [ ] apply: orchestrator adds src/chain-range-prune.ts, src/chain-range-prune.test.ts"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-range-prune.test.ts` green"
  - phase: task-3-indexer-extensions-and-chain-compressor
    steps:
      - "- [ ] proposal: subagent designs chain registry on the indexer (Map<startUserTimestamp, ChainCompressionEntry>), rebuild-from-session_start logic, getToolRefsForToolCallIds + hasPerBatchSummaryCoveringAny + getPerBatchSummaryTextForToolCallIds helpers, and the chain-compressor orchestrator (rolling-window eligibility, refusal when no per-batch summary covers any middleToolCallIds, persistence via pi.appendEntry)"
      - "- [ ] review: reviewer validates that compressEligible never compresses chains within the K-window, that no double-compression can happen across reload, that helper queries match the existing indexer data shapes (toolCallRefs overlap)"
      - "- [ ] apply: orchestrator modifies src/indexer.ts (additive — chain registry alongside existing tool-call map), adds src/chain-compressor.ts + src/chain-compressor.test.ts (eligibility filter unit test); records compressor counters in the stats accumulator output"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-compressor.test.ts` green"
  - phase: task-4-pruner-and-index-wiring
    steps:
      - "- [ ] proposal: subagent designs pruner.ts composition (run chain-range-prune AFTER the existing stub-replace pass), the summaryTextById lookup function source, index.ts integration (call chain-compressor.compressEligible at tail of flushPending, rebuild chain state on session_start, thread chain entries + summary lookup into context handler)"
      - "- [ ] review: reviewer validates that the existing stub pruner contract is preserved (no regression), that ordering of transforms is correct, that per-batch summary suppression matches the toolCallRefs-overlap rule documented in §5"
      - "- [ ] apply: orchestrator modifies src/pruner.ts + index.ts; adds smoke-test guards (skip chain compression if registry is empty)"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; smoke run with `PI_CODING_AGENT_DIR=$(mktemp -d) pi -e ./index.ts ...` against a multi-step task; observe `context-prune-chain` entries written once the 4th chain closes and context size drops on the next turn"
  - phase: task-5-pruner-compact-and-defaults-and-docs
    steps:
      - "- [ ] proposal: subagent designs the /pruner compact subcommand (effectiveK=0 path through compressEligible, success notification with reclaimed-token estimate), settings overlay row (matching the protectedTools pattern from 031-task-3), default-config additions, and the PRUNING.md / README.md / AGENTS.md doc updates"
      - "- [ ] review: reviewer validates that defaults match Section 10 of this plan (enabled=true, rollingWindow=3, stripFinalAssistantThinking=true), that the /pruner compact reachability is identical to /pruner protected-tools, that PRUNING.md additions follow the existing doc voice (compact, no preamble)"
      - "- [ ] apply: orchestrator modifies src/commands.ts (compact subcommand + SettingsList row), src/types.ts DEFAULT_CONFIG, PRUNING.md (new Chain Compression section), README.md (config table rows + /pruner compact reference), AGENTS.md (custom-entry table row)"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `/pruner compact` smoke run in an existing session with >3 closed chains; confirm reclaimed-token notification fires and subsequent context shrinks"
  - phase: task-6-nested-placeholders
    steps:
      - "- [ ] proposal: subagent designs src/nested-placeholders.ts (substituteBlockRefs with one-level expansion, missing-block left as literal, self-reference refused), test suite, and wire into buildSyntheticChainMessage (run substitution on summary text before XML wrapping)"
      - "- [ ] review: reviewer validates substitution rules, test coverage of cycle detection, no breakage of phase-1 chain-range-prune"
      - "- [ ] apply: orchestrator adds src/nested-placeholders.ts + test, modifies src/chain-range-prune.ts to invoke substitution with a blockSummaryLookup from the chain registry"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/nested-placeholders.test.ts` green; existing chain-range-prune tests still green"
  - phase: task-7-error-purge
    steps:
      - "- [ ] proposal: subagent designs src/error-purge.ts (detect errored ToolResultMessage via isError flag, match to assistant toolCall by toolCallId, replace arguments body with `<purged-errored-args size=\"N\"/>` when chars > minArgChars and age > cooldownTurns), test suite, and wire into pruner.ts (run between stub-replace and chain-range-prune)"
      - "- [ ] review: reviewer validates that purge respects cooldown + minArgChars thresholds, that errored toolResult content is left untouched (only the upstream toolCall arg body is purged), that pure transform preserves message ordering"
      - "- [ ] apply: orchestrator adds src/error-purge.ts + test, modifies src/pruner.ts (insert purge step), src/types.ts (ErrorPurgeConfig + DEFAULT_CONFIG additions), src/commands.ts (settings overlay row), README.md + PRUNING.md doc rows"
      - "- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/error-purge.test.ts` green; smoke run with a forced tool error confirms args are purged after the cooldown"
  - phase: task-8-final-verification
    steps:
      - "- [ ] full typecheck pass: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`"
      - "- [ ] full test pass: `bun test src/`"
      - "- [ ] integration smoke: isolated `PI_CODING_AGENT_DIR`, multi-step task touching >5 chains, verify context-prune-chain entries written, verify context-prune-summary entries within compressed ranges are suppressed at render time, verify `/pruner compact` works"
      - "- [ ] AGENTS.md Code Structure section reflects all new files (chain-detector, chain-range-prune, block-refs, chain-compressor, nested-placeholders, error-purge)"
      - "- [ ] no stale references to pre-existing scope that was cut (cross-model-strip)"
---

# 032 — Chain Compression + Auxiliary Strategies

## 1. Problem and goal

The existing per-batch pruner replaces tool-result *content* with short stubs (`[Summarized in pruner summary, ref \`t5\`. Use context_tree_query to retrieve full output.]`). It does not touch assistant turns. For long sessions (e.g. `2026-05-28T10-34-13-291Z_…`) where the model uses thinking blocks heavily, the bulk of remaining context becomes:

| Component (in a 484-message session at ~391K prompt tokens) | Raw chars | Pruner reach today |
|---|---|---|
| Assistant `thinkingSignature` blobs | ~592K | None — sent verbatim back to Anthropic for replay |
| Assistant `thinking` cleartext | ~184K | None |
| Assistant `toolCall` arguments | ~315K | None |
| Tool result stubs (post-prune) | ~35K | Pruned |
| Per-batch summaries | ~41K | These ARE the pruner's output |
| Assistant `text` blocks | ~82K | None |

The bulk that the existing pruner cannot touch (~1.1M chars) lives in assistant messages. Anthropic's signature continuity rule (within an active tool-using cycle) is the reason the pruner has historically avoided assistant content — but the rule only binds *within* a chain. Once a chain closes with a text-only assistant message and a new user message starts the next chain, earlier chains' signatures are no longer load-bearing.

This plan adds **range compression** for closed chains beyond a small rolling window, modeled on `Opencode-DCP`'s `filterCompressedRanges` (`lib/messages/prune.ts:130-200`). Compression is purely structural in phase 1: no new LLM call.

## 2. Architecture overview

Three independent transforms compose in this order at `pi.on("context")`:

```
raw session messages
       │
       ▼
[1] tool-result stub replace (existing — src/pruner.ts)
       │  raw tool-result content → "[Summarized…ref `tN`]"
       ▼
[2] error-purge (phase 2 — src/error-purge.ts)
       │  errored toolCall arg body → "<purged-errored-args size=N/>"
       ▼
[3] chain-range-prune (phase 1 — src/chain-range-prune.ts)
       │  for each chain in chainEntries:
       │    keep startUserMessage as-is
       │    drop ToolResultMessages whose toolCallId ∈ droppedToolCallIds
       │    drop AssistantMessages whose ToolCall blocks include any droppedToolCallIds
       │    suppress context-prune-summary custom_messages whose toolCallRefs overlap droppedToolCallIds
       │    inject synthetic user message right after the user msg whose timestamp == startUserTimestamp:
       │      <compressed-chain id="b1" tools="t3,t4,t5">…summary text…</compressed-chain>
       │    strip thinking blocks from the assistant whose timestamp == finalAssistantTimestamp
       ▼
filtered messages → LLM
```

The compose order matters: the stub replace + error purge run **first** (per-message content transforms, additive), and chain-range-prune runs **last** (structural drop/insert across the whole array). This lets the inner per-tool short refs (`t3`, `t4`, `t5`) be harvested into the chain's `tools="..."` attribute even though the tool-result *messages* are about to be dropped — `context_tree_query` still recovers their full content from the underlying `context-prune-index` entries.

The per-batch stub pruner and per-batch summarizer continue to run on every `message_end` / `agent-message` boundary, unchanged.

## 3. Components

| File | New / modified | Concern | Pure? |
|---|---|---|---|
| `src/types.ts` | mod | `ChainCompressionEntry`, `CUSTOM_TYPE_CHAIN`, `ChainCompressionConfig`, `ErrorPurgeConfig` | yes |
| `src/chain-detector.ts` | new | Walk `AgentMessage[]` (or `SessionEntry[]`-derived equivalents) and emit `ChainRange[]` | yes |
| `src/block-refs.ts` | new | Issue monotonic `b<N>` IDs; rebuild counter from `context-prune-chain` entries on session start | yes |
| `src/chain-range-prune.ts` | new | `(messages, chainEntries, summaryTextLookup) → AgentMessage[]`; performs drop, insert, suppress, thinking-strip | yes |
| `src/chain-compressor.ts` | new | Rolling-window eligibility, harvest `toolRefs` from indexer, persist `context-prune-chain` entry, call `compressOldest` from inside `flushPending` | no (uses `pi.appendEntry`) |
| `src/indexer.ts` | mod | Add chain registry; rebuild from `context-prune-chain` entries on `session_start`; helper `getToolRefsInRange(chainRange) → string[]` |  no |
| `src/pruner.ts` | mod | Compose `[stub-replace] → [error-purge?] → [chain-range-prune]` in `pruneMessages` | no |
| `src/commands.ts` | mod | `/pruner compact` subcommand triggering retroactive compression of all eligible-but-uncompressed chains | no |
| `src/nested-placeholders.ts` (phase 2) | new | `{b1}` → resolved summary text substitution; cycle detection (refuse self-references) | yes |
| `src/error-purge.ts` (phase 2) | new | Detect errored toolCalls; produce mutated assistant message with arg stub | yes |
| `index.ts` | mod | Call `chain-compressor` at tail of `flushPending`; pass `chainEntries` + summary lookup to context handler; register `/pruner compact`; rebuild on `session_start` | no |

**File-per-concern** is the project's existing convention. Pure transforms isolate the logic that's easy to TDD; orchestrators (`chain-compressor`, `index.ts` glue) stay small and integration-tested via smoke runs.

## 4. Data shapes

```ts
// src/types.ts (additions)

export const CUSTOM_TYPE_CHAIN = "context-prune-chain";

/**
 * Detected (pre-decision) shape, emitted by chain-detector. Distinct from the persisted ChainCompressionEntry below.
 *
 * Identification model: `AgentMessage` (pi-ai's `Message` union) has no `.id` field. Messages are identified by:
 *   - `timestamp` for user / final-assistant boundary messages (1 ms precision; collisions vanishingly rare in a single agent loop)
 *   - `toolCallId` set for the middle (every AssistantMessage tool-using turn carries `ToolCall` content blocks with stable ids; every ToolResultMessage carries the same `toolCallId`)
 */
export interface ChainRange {
  /** Timestamp of the user message that opens the chain. */
  startUserTimestamp: number;
  /**
   * All toolCallIds in the chain's middle (deduplicated).
   * Collected from both AssistantMessage `ToolCall` blocks AND matching `ToolResultMessage` entries.
   * Used at transform time to: (1) drop matching `ToolResultMessage`s, (2) identify and drop middle `AssistantMessage`s, (3) suppress per-batch `context-prune-summary` messages whose `details.toolCallRefs` overlap.
   */
  middleToolCallIds: string[];
  /** Timestamp of the final text-only assistant that closes the chain, or `null` if the session truncates mid-chain. */
  finalAssistantTimestamp: number | null;
}

/** Persisted per chain that has been range-dropped from LLM context. */
export interface ChainCompressionEntry {
  /** Stable block ID, monotonic per session: "b1", "b2", ... */
  blockId: string;
  /** Timestamp of the user message that opens the chain. Kept raw; synthetic chain message is inserted right after this user message. */
  startUserTimestamp: number;
  /**
   * ToolCallIds of all dropped middle messages.
   * Used at transform time to: drop matching `ToolResultMessage`s, drop `AssistantMessage`s whose `ToolCall` blocks include any of these ids, and suppress `context-prune-summary` `custom_message` entries whose `details.toolCallRefs` overlap.
   */
  droppedToolCallIds: string[];
  /** Timestamp of the final text-only assistant in the chain. Kept in context with thinking blocks stripped. `null` if the chain has no final text-only assistant (truncated session). */
  finalAssistantTimestamp: number | null;
  /** Short `t<N>` refs for tool calls inside this chain. Harvested from `context-prune-index` at compress time. Surfaces in the synthetic message's `tools="..."` attribute so `context_tree_query` remains discoverable. */
  toolRefs: string[];
  /** Timestamp the compression was decided (for debugging / stats). */
  compressedAt: number;
}

// Note: per-batch summary suppression does NOT need a stored ID list. At transform time, suppress any `context-prune-summary` custom message whose `details.toolCallRefs` overlap with any active chain's `droppedToolCallIds`. The same lookup also produces the summary TEXT used inside the synthetic `<compressed-chain>` body.

export interface ChainCompressionConfig {
  enabled: boolean;          // default true
  rollingWindow: number;     // default 3
  stripFinalAssistantThinking: boolean; // default true
}

export interface ErrorPurgeConfig {
  enabled: boolean;          // default true (phase 2)
  cooldownTurns: number;     // default 2
  minArgChars: number;       // default 500
}
```

`ChainCompressionEntry` is persisted via `pi.appendEntry(CUSTOM_TYPE_CHAIN, entry)` — same pattern as `CUSTOM_TYPE_INDEX`, `CUSTOM_TYPE_DEDUP_ALIAS`, `CUSTOM_TYPE_FRONTIER`.

The synthetic chain message itself is **not** persisted as a `custom_message` entry. It's constructed on the fly inside `chain-range-prune` at every `context` event from `ChainCompressionEntry` + per-batch summary text(s) looked up by `toolCallRefs` overlap with `droppedToolCallIds`. This keeps a single source of truth: the summary text lives once, in its original `context-prune-summary` entry, and the chain entry stores only structural data.

## 5. Algorithm — `chain-range-prune` (pure)

```ts
function applyChainCompressions(
  messages: AgentMessage[],
  chainEntries: ChainCompressionEntry[],
  summaryTextForChain: (entry: ChainCompressionEntry) => string,
  stripFinalThinking: boolean,
): AgentMessage[] {
  // Build per-toolCallId / per-timestamp lookup sets.
  const droppedToolCallIds = new Set<string>();              // ToolResult drop + middle AssistantMessage drop key
  const stripFinalAtTimestamp = new Set<number>();           // Final assistant timestamps where we strip thinking
  const insertAfterUserTimestamp = new Map<number, AgentMessage>(); // user.timestamp → synthetic message
  for (const e of chainEntries) {
    for (const id of e.droppedToolCallIds) droppedToolCallIds.add(id);
    insertAfterUserTimestamp.set(e.startUserTimestamp, buildSyntheticChainMessage(e, summaryTextForChain(e)));
    if (e.finalAssistantTimestamp !== null && stripFinalThinking) {
      stripFinalAtTimestamp.add(e.finalAssistantTimestamp);
    }
  }

  const out: AgentMessage[] = [];
  for (const msg of messages) {
    // 1. Drop ToolResultMessages whose toolCallId is in any compressed chain.
    if (msg.role === "toolResult" && droppedToolCallIds.has(msg.toolCallId)) continue;
    // 2. Drop AssistantMessages whose ToolCall blocks include any dropped id.
    if (msg.role === "assistant") {
      const callIds = (msg.content ?? []).filter(c => c.type === "toolCall").map(c => (c as ToolCall).id);
      if (callIds.some(id => droppedToolCallIds.has(id))) continue;
      // Strip thinking blocks from the kept final text-only assistant.
      if (stripFinalAtTimestamp.has(msg.timestamp)) {
        out.push(withoutThinkingBlocks(msg));
        continue;
      }
    }
    // 3. Suppress per-batch summary custom_messages whose toolCallRefs overlap any dropped id.
    if (isPerBatchSummaryMessage(msg) && perBatchSummaryOverlapsDropped(msg, droppedToolCallIds)) continue;

    out.push(msg);

    // 4. Insert synthetic chain message right after the matching user message.
    if (msg.role === "user") {
      const synthetic = insertAfterUserTimestamp.get(msg.timestamp);
      if (synthetic) out.push(synthetic);
    }
  }
  return out;
}

function buildSyntheticChainMessage(e: ChainCompressionEntry, summary: string): AgentMessage {
  const tools = e.toolRefs.join(",");
  return {
    role: "user",
    content: [{ type: "text", text: `<compressed-chain id="${e.blockId}" tools="${tools}">\n${summary}\n</compressed-chain>` }],
    timestamp: e.compressedAt, // deterministic; never collides with a real user message because it's the compress-time epoch ms
  };
}
```

**Ordering invariant:** the output is in the same order as the input, with strictly-positional insertions (right after the user message whose `timestamp === startUserTimestamp`) and deletions (by toolCallId or by per-batch-summary overlap). No reorder of remaining messages. Bun-tested.

**Helpers:** `isPerBatchSummaryMessage` checks for a `custom_message` shape with `customType === "context-prune-summary"` reaching the pruner via the message stream; `perBatchSummaryOverlapsDropped` reads `details.toolCallRefs[].toolCallId` and tests against `droppedToolCallIds`. `summaryTextForChain` does the same overlap lookup to extract the per-batch summary text content for the synthetic body.

## 6. Algorithm — `chain-detector` (pure)

The detector emits **`ChainRange`** (the *detected* shape from §4), distinct from **`ChainCompressionEntry`** (the *persisted* shape after a compression decision). `chain-compressor` consumes `ChainRange[]` and produces `ChainCompressionEntry[]` by adding `blockId`, `toolRefs`, `compressedAt`.

The detector runs on **raw session messages** (pre-prune); the synthetic-message skip filter described below is **defensive only** — raw streams from `pi.on("context")` should not contain synthetic `<compressed-chain>` messages, since synthetics are produced exclusively inside the in-flight `pi.on("context")` transform, never persisted.

State machine over the message stream:

```
state ← idle
chainStart ← null
middleIds ← []
for msg in messages:
  if msg.role == "user":
    if state == inChain:  // open chain interrupted (unusual)
      emit ChainRange(chainStart, middleIds, finalAssistant=null)
    chainStart ← msg
    middleIds ← []
    state ← inChain  (chain "opened" at this user msg)
  elif msg.role == "assistant" and hasToolCalls(msg):
    middleIds.push(msg.id); state ← inChain
  elif msg.role == "toolResult":
    middleIds.push(msg.id); state ← inChain
  elif msg.role == "assistant" and !hasToolCalls(msg):  // text-only close
    emit ChainRange(chainStart.id, middleIds, finalAssistant=msg.id)
    state ← idle
```

**Filters before emitting:**
- Skip chains where `chainStart` is the synthetic chain message of an earlier compression (detected by content prefix `<compressed-chain`). These chains are already compressed.
- Skip open chains (no text-only final). They're either in flight or the session was truncated.

`ChainRange` = `{ startUserTimestamp, middleToolCallIds, finalAssistantTimestamp }` (defined in §4).

## 7. Algorithm — `chain-compressor` (orchestrator)

Called at the tail of `flushPending`:

```
chainsAll ← chainDetector(currentMessages)
chainsClosed ← chainsAll.filter(c => c.finalAssistantTimestamp !== null && !alreadyCompressed(c))
chainsOldEnough ← chainsClosed.slice(0, max(0, chainsClosed.length - K))  // all but the last K
for chain in chainsOldEnough:
  if !indexer.hasPerBatchSummaryCoveringAny(chain.middleToolCallIds): continue   // refuse if no summary available
  blockId ← blockRefs.issue()
  toolRefs ← indexer.getToolRefsForToolCallIds(chain.middleToolCallIds)
  entry ← {blockId, startUserTimestamp: chain.startUserTimestamp, droppedToolCallIds: chain.middleToolCallIds, finalAssistantTimestamp: chain.finalAssistantTimestamp, toolRefs, compressedAt: now}
  pi.appendEntry(CUSTOM_TYPE_CHAIN, entry)
  registry.add(entry)
```

`alreadyCompressed(c)` checks the registry, keyed on `startUserTimestamp`. After persistence, future `context` events automatically include this entry in the chain-range-prune transform.

**`/pruner compact` slash command** = same routine, but uses K=0 effectively (compresses *every* closed chain that isn't already compressed). User-initiated retroactive compression.

## 8. Co-existence with the per-batch stub pruner

Tool-result stubs (set 1) and chain-range-prune (set 3) **never conflict** because they operate on different content:

- Stubs replace `ToolResultMessage.content` text. The message persists.
- Chain compression drops the *entire* `ToolResultMessage` for messages inside a compressed chain.

When chain compression drops a tool-result message, its already-stubbed content is also dropped. The information lives in:
1. The per-batch `context-prune-index` entry (which the stub pruner wrote when the batch flushed) — accessible via `context_tree_query("t5")`.
2. The chain summary text inside the synthetic message — high-level description of what happened.

For the **K most recent chains** (within the rolling window), no chain compression applies; the model sees stubbed tool results with `tN` refs as today.

## 9. Edge cases

| Case | Behavior |
|---|---|
| Chain currently in-flight (no text-only close yet) | Not eligible. Chain detector skips it. |
| Session has < K+1 closed chains | No compression happens. Rolling window not full. |
| Session reload (`session_start`) | Indexer scans `context-prune-chain` entries, populates registry. Each entry replays at the next `context` event. No re-compression of historical chains unless `/pruner compact` is invoked. |
| Per-batch summary for a chain is missing (LLM call failed at batch close) | No `context-prune-summary` `custom_message` has `toolCallRefs` overlapping the chain's `middleToolCallIds`. Chain detector still emits the range, but chain-compressor refuses to compress chains with no summary available (`hasPerBatchSummaryCoveringAny` returns false). Logged as a `skipped-no-summary` outcome in stats. |
| Final text-only assistant has *only* a thinking block, no text | After thinking strip, content is empty. Pi-ai's transform-messages drops empty assistant blocks. Treat as if final assistant was missing — entry's `finalAssistantTimestamp` set to null at compress time. |
| User message contains content other than text (e.g. image) | Not a synthetic chain message. Skip detection; not a chain start trigger. |
| Synthetic chain message from an earlier compression appears mid-stream | Defensive only — raw streams from `pi.on("context")` do not contain synthetic messages (synthetics live exclusively in the in-flight transform output, not in session storage). The detector still filters them by content prefix `<compressed-chain` to be safe against future code-path changes. |
| Block ID collision after a session_start partial state | `block-refs` rebuilds the counter from the max persisted `bN` ID + 1. |
| User changes `rollingWindow` mid-session | Takes effect on the next `flushPending`. Already-compressed chains stay compressed; never un-compressed (deterministic forward motion). |
| Configuration disabled mid-session | New compressions stop. Existing `context-prune-chain` entries continue to replay; existing compressions stay applied. To "undo," the user would need to delete entries from the session JSONL manually. Documented in PRUNING.md. |
| Cross-model session (user switched provider mid-session) | Out of scope. pi-ai's `transformMessages` already strips thinking signatures cross-model in the provider transform; our pruner runs before that. |
| `pi.appendEntry` write fails | Compression skipped; registry not updated; chain remains uncompressed; retry on next flush. Same robustness model as existing index writes. |
| Prefix-cache impact | Adding a new chain entry rewrites the affected range of the prompt → cache bust from the chain's start-user message onward. Same trade-off as the existing per-batch stub pruner. Mitigation: the rolling window of K=3 means compression decisions happen at predictable points (one closure per batch close cycle), not continuously. Cache stability for the most-recent K chains is preserved verbatim. |

## 10. Configuration defaults and migration

New `ContextPruneConfig` fields, all on-by-default:

| Setting | Default | Description |
|---|---|---|
| `chainCompression.enabled` | `true` | Master toggle |
| `chainCompression.rollingWindow` | `3` | Number of most-recent closed chains kept raw |
| `chainCompression.stripFinalAssistantThinking` | `true` | Strip thinking blocks from kept final assistant text |
| `purgeErrors.enabled` (phase 2) | `true` | Replace errored toolCall arg bodies with stubs |
| `purgeErrors.cooldownTurns` (phase 2) | `2` | Wait N turns after the error before purging args |
| `purgeErrors.minArgChars` (phase 2) | `500` | Don't bother purging small arg bodies |

**Migration**: a user upgrading to this version with an existing session will see chain compression activate on the next `flushPending` for chains beyond the rolling window. No retroactive rewrite of past sessions. To compress immediately: `/pruner compact`.

**Release**: this is a minor version bump per the existing release skill — additive feature, on by default, no breaking API changes.

## 11. Testing approach

`bun:test` as the runner (`bun` is already required by the project's typecheck command per `AGENTS.md`; no new dev dependency). Tests live in `src/*.test.ts` next to each module. `package.json` gains `"test": "bun test src/"`.

**Pure-function tests (TDD-friendly):**

| Module | Test cases |
|---|---|
| `chain-detector` | Single chain end-to-end; multiple chains in a row; open chain (skipped); synthetic compressed-chain message in stream (not treated as new chain start); chain with no text-only close (skipped); chain interrupted by a second user message (defensive — first chain emitted with `null` final) |
| `block-refs` | Issuance is monotonic; rebuild from `["b1","b3"]` → next is `b4`; rebuild from empty → `b1` |
| `chain-range-prune` | **Ordering invariant** (output messages in the same order as input minus dropped); drops by `toolCallId` (ToolResult + AssistantMessage); insertion is exactly after the user message whose `timestamp === startUserTimestamp`; suppression of per-batch summary by `toolCallRefs` overlap; thinking-block strip on the assistant whose `timestamp === finalAssistantTimestamp`; idempotent (calling twice yields the same result) |
| `nested-placeholders` (phase 2) | Simple `{b1}` substitution; multiple references; nested substitution (resolved `b2` text mentions `{b1}` — substitute one level); self-reference refused; missing block ID left as `{bN}` literal |
| `error-purge` (phase 2) | Errored toolCall identified by `toolResult.isError` true on the matching result; arg body replaced; non-errored unchanged; cooldown respected; small args under `minArgChars` left raw |

**Integration smoke tests (per `AGENTS.md` pattern):**

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) \
  pi -e ./index.ts --no-extensions -p "do a multi-step task that touches several files"
jq -r 'select(.type == "custom" or .type == "custom_message") | .customType' \
  $PI_CODING_AGENT_DIR/sessions/*/*.jsonl | sort | uniq -c
# Expect: context-prune-chain entries written once rolling window is full
```

**Typecheck:** `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts` per AGENTS.md.

## 12. What this does NOT do

- **No new LLM calls in phase 1.** Chain summary text is read verbatim from existing `context-prune-summary` entries by message ID. Phase 1 cost is structural-only.
- **No cross-model thinking-signature handling.** pi-ai's `transformMessages` already strips/converts thinking blocks when the assistant's model ≠ the current model. Adding our own layer would duplicate.
- **No retroactive compression on session reload.** Strict by default; user must invoke `/pruner compact` to compress old chains in an existing oversized session.
- **No decompression / re-expansion of compressed ranges.** The session JSONL is the durable source of truth; if a user wants to "recover" a compressed chain, the messages are still in the session file (just filtered out at LLM-context time). Manual recovery requires deleting `context-prune-chain` entries from the session. Mentioned in `PRUNING.md`.
- **No model-callable compress tool** (DCP-style). Pruner remains autonomous + heuristic. A future v3 could add this.

## 13. Files

**Create:**
- `src/chain-detector.ts` + `src/chain-detector.test.ts`
- `src/block-refs.ts` + `src/block-refs.test.ts`
- `src/chain-range-prune.ts` + `src/chain-range-prune.test.ts`
- `src/chain-compressor.ts` + `src/chain-compressor.test.ts` (orchestrator + an eligibility-filter unit test)
- `src/nested-placeholders.ts` + `src/nested-placeholders.test.ts` (phase 2)
- `src/error-purge.ts` + `src/error-purge.test.ts` (phase 2)

**Modify:**
- `src/types.ts` (additive: `ChainCompressionEntry`, `ChainRange`, `CUSTOM_TYPE_CHAIN`, `ChainCompressionConfig`, `ErrorPurgeConfig`, `DEFAULT_CONFIG` additions)
- `src/indexer.ts` (additive: chain registry, `getToolRefsInRange`, `getPerBatchSummaryIdsForRange`, rebuild on `session_start`)
- `src/pruner.ts` (compose `[stub-replace] → [error-purge] → [chain-range-prune]` in `pruneMessages`)
- `src/commands.ts` (add `/pruner compact` subcommand + settings overlay rows for the new config keys)
- `index.ts` (call `chain-compressor.compressEligible` at the tail of `flushPending`; rebuild chain state + block-ref counter on `session_start`; thread chain entries + summary-text lookup to the context handler)
- `package.json` (add `"test": "bun test src/"` script)
- `PRUNING.md` (Chain Compression section, Error Purge section)
- `README.md` (config-table rows for the new keys + `/pruner compact` reference)
- `AGENTS.md` (custom-entry table row for `context-prune-chain`; Code Structure section reflects new files)

**Delete:** none.

## 14. Task breakdown (matching 031's proposal → review → apply → verify pattern)

Each task is dispatched as a proposal subagent first, reviewed in fresh context, then applied by the orchestrator. Tasks are ordered so each one's dependencies are satisfied by earlier tasks.

### Task 1 — Types + chain-detector + block-refs
- [ ] proposal: subagent designs `ChainCompressionEntry` / `ChainRange` / `CUSTOM_TYPE_CHAIN` / `ChainCompressionConfig` types in `src/types.ts`, the chain-detector state-machine (with synthetic-message passthrough + open-chain skip), and block-refs issuer + rebuild logic; lists exact bun:test cases; specifies `package.json` test-script + any tsconfig changes for bun:test
- [ ] review: reviewer validates type field names match Section 4, state-machine covers Section 9 edge cases, test list covers the ordering invariant + synthetic-passthrough + open-chain-skip + rebuild-from-gapped-sequence
- [ ] apply: orchestrator adds types, `src/chain-detector.ts`, `src/chain-detector.test.ts`, `src/block-refs.ts`, `src/block-refs.test.ts`, `package.json` test script, AGENTS.md custom-entry table row
- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-detector.test.ts src/block-refs.test.ts` green

### Task 2 — chain-range-prune
- [ ] proposal: subagent designs `applyChainCompressions(...)` per Section 5, `withoutThinkingBlocks` helper, `buildSyntheticChainMessage` helper (using the `<compressed-chain>` XML wrapper from §5 — the format referred to elsewhere in this plan as "F2"), and the test suite covering ordering invariant + insert position + drop-by-id + summary suppression + thinking strip + idempotency
- [ ] review: reviewer validates the synthetic message ID scheme is deterministic, the `<compressed-chain>` XML wrapping exactly matches §5, ordering invariant test uses non-trivial input permutations
- [ ] apply: orchestrator adds `src/chain-range-prune.ts`, `src/chain-range-prune.test.ts`
- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-range-prune.test.ts` green

### Task 3 — indexer extensions + chain-compressor
- [ ] proposal: subagent designs the chain registry on the indexer (`Map<startUserTimestamp, ChainCompressionEntry>`), rebuild-from-session_start logic, `getToolRefsForToolCallIds` + `hasPerBatchSummaryCoveringAny` + `getPerBatchSummaryTextForToolCallIds` helpers (all keyed on `toolCallRefs` overlap with `middleToolCallIds`), and the chain-compressor orchestrator (rolling-window eligibility, refusal when `hasPerBatchSummaryCoveringAny` returns false, persistence via `pi.appendEntry`); identifies one pure sub-function to unit-test: the eligibility filter (`(chains, K, alreadyCompressedTimestamps) → chains-to-compress`) so K-window regressions are caught without a full smoke run
- [ ] review: reviewer validates `compressEligible` never compresses chains within the K-window, no double-compression across session reload, helper queries match the existing indexer data shapes, the eligibility-filter test covers `len < K` / `len == K` / `len > K` / `alreadyCompressed` cases
- [ ] apply: orchestrator modifies `src/indexer.ts` (additive — chain registry alongside existing tool-call map), adds `src/chain-compressor.ts` + `src/chain-compressor.test.ts` (eligibility filter only), records compressor counters in the stats accumulator
- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/chain-compressor.test.ts` green

### Task 4 — pruner.ts + index.ts wiring
- [ ] proposal: subagent designs the `pruner.ts` composition (run chain-range-prune after the existing stub-replace pass), the `summaryTextById` lookup function source, `index.ts` integration (call `chain-compressor.compressEligible` at tail of `flushPending`, rebuild chain state on `session_start`, thread chain entries + summary lookup into the context handler)
- [ ] review: reviewer validates the existing stub-pruner contract is preserved (no regression), transform order is correct, per-batch summary suppression matches the `toolCallRefs`-overlap rule from §5
- [ ] apply: orchestrator modifies `src/pruner.ts` + `index.ts`; adds smoke-test guards (skip chain compression if registry is empty)
- [ ] verify: `bun x tsc --noEmit ...` clean; smoke run with `PI_CODING_AGENT_DIR=$(mktemp -d) pi -e ./index.ts ...` against a multi-step task; observe `context-prune-chain` entries written once the 4th chain closes and context size drops on the next turn

### Task 5 — `/pruner compact` + defaults + docs
- [ ] proposal: subagent designs the `/pruner compact` subcommand (effectiveK=0 path through `compressEligible`, success notification with reclaimed-token estimate computed as `⌈droppedChars / 4⌉` summed across the chains compressed in the call), settings overlay row (matching the protectedTools pattern from 031-task-3), `DEFAULT_CONFIG` additions, and the PRUNING.md / README.md / AGENTS.md doc updates
- [ ] review: reviewer validates defaults match Section 10 (enabled=true, rollingWindow=3, stripFinalAssistantThinking=true), `/pruner compact` reachability is identical to `/pruner protected-tools`, PRUNING.md additions follow the existing doc voice (compact, no preamble)
- [ ] apply: orchestrator modifies `src/commands.ts` (compact subcommand + SettingsList row), `src/types.ts` `DEFAULT_CONFIG`, `PRUNING.md` (new Chain Compression section), `README.md` (config-table rows + `/pruner compact` reference), `AGENTS.md` (custom-entry table row)
- [ ] verify: `bun x tsc --noEmit ...` clean; `/pruner compact` smoke run in an existing session with >3 closed chains confirms the reclaimed-token notification fires and subsequent context shrinks

### Task 6 — nested placeholders (phase 2)
- [ ] proposal: subagent designs `src/nested-placeholders.ts` (`substituteBlockRefs` with one-level expansion, missing-block left as literal `{bN}`, self-reference refused), test suite, and wire into `buildSyntheticChainMessage` (run substitution on summary text before XML wrapping)
- [ ] review: reviewer validates substitution rules, test coverage of cycle detection, no breakage of phase-1 chain-range-prune
- [ ] apply: orchestrator adds `src/nested-placeholders.ts` + test, modifies `src/chain-range-prune.ts` to invoke substitution with a `blockSummaryLookup` from the chain registry
- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/nested-placeholders.test.ts` green; existing `chain-range-prune` tests still green

### Task 7 — error purge (phase 2)
- [ ] proposal: subagent designs `src/error-purge.ts` (detect errored `ToolResultMessage` via `isError` flag, match to assistant `toolCall` by `toolCallId`, replace arg body with `<purged-errored-args size="N"/>` when chars > `minArgChars` AND age > `cooldownTurns`), test suite, and wire into `pruner.ts` (run between stub-replace and chain-range-prune)
- [ ] review: reviewer validates purge respects `cooldownTurns` + `minArgChars`, errored toolResult content is left untouched (only the upstream toolCall arg body is purged), pure transform preserves message ordering
- [ ] apply: orchestrator adds `src/error-purge.ts` + test, modifies `src/pruner.ts` (insert purge step), `src/types.ts` (`ErrorPurgeConfig` + `DEFAULT_CONFIG` additions), `src/commands.ts` (settings overlay row), `README.md` + `PRUNING.md` doc rows
- [ ] verify: `bun x tsc --noEmit ...` clean; `bun test src/error-purge.test.ts` green; smoke run with a forced tool error confirms args are purged after the cooldown

### Task 8 — final verification
- [ ] full typecheck pass: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
- [ ] full test pass: `bun test src/`
- [ ] integration smoke: isolated `PI_CODING_AGENT_DIR`, multi-step task touching >5 chains; verify `context-prune-chain` entries written; verify `context-prune-summary` entries within compressed ranges are suppressed at render time; verify `/pruner compact` works
- [ ] AGENTS.md Code Structure section reflects all new files (`chain-detector`, `chain-range-prune`, `block-refs`, `chain-compressor`, `nested-placeholders`, `error-purge`)
- [ ] no stale references to pre-existing scope that was cut (`cross-model-strip`)
