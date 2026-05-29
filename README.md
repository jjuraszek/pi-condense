# pi-context-prune

A [Pi coding-agent](https://github.com/badlogic/pi-mono) extension that summarizes completed tool-call batches, replaces raw tool outputs with short stubs in future context, and lets the LLM recover any original via the `context_tree_query` tool.

The session JSONL file is never modified — pruning only affects what each *next* request sees.

Fork of [`championswimmer/pi-context-prune`](https://github.com/championswimmer/pi-context-prune) with additional pre-flush safeguards, agent-message batching, and tag-pinned release flow.

📖 For the algorithm, design rationale, prompt-cache interaction, and the research behind summarization-based context management, see **[PRUNING.md](PRUNING.md)**.

## Install

This fork is consumed as a pi package via a **git tag pin** — same scheme as sibling [`pi-superpowers`](https://github.com/jjuraszek/pi-superpowers).

**User scope** (all repos under your pi profile):

```bash
pi install git:github.com/jjuraszek/pi-context-prune@v0.11.1
```

**Project scope** (current repo only, committable via `.pi/settings.json`):

```bash
pi install -l git:github.com/jjuraszek/pi-context-prune@v0.11.1
```

**Try without installing**:

```bash
pi -e git:github.com/jjuraszek/pi-context-prune@v0.11.1
```

**From a local checkout** (for hacking on the extension itself):

```bash
git clone git@github.com:jjuraszek/pi-context-prune.git ~/repos/pi-context-prune
cd ~/path/to/your/repo
pi install -l ~/repos/pi-context-prune
# or one-shot, no install:
pi -e ~/repos/pi-context-prune/index.ts
```

Upgrade by re-running `pi install` with a newer `@vX.Y.Z`. Remove with `pi remove pi-context-prune`. Once installed, the extension auto-loads on every `pi` invocation; no flags needed.

> Upstream `championswimmer/pi-context-prune` does publish to npm. This fork **does not** — pin a tag instead. See [CHANGELOG.md](CHANGELOG.md) for what diverges.

## Quick start

```bash
/pruner on                          # enable pruning
/pruner status                      # see current mode + cumulative cost
/pruner model openai/gpt-4.1-mini   # pick a cheap summarizer
/pruner now                         # flush pending batches immediately
```

By default the extension is **off**. Enable it once and it stays enabled across sessions in the same pi agent directory.

## How it decides when to prune

Five trigger modes. The mode controls *when* summarization fires; the algorithm is the same in each.

| Mode | Trigger | Cache impact | Use when |
|---|---|---|---|
| `agent-message` (default) | When the agent sends a final text-only reply | One cache rewrite per task batch | Normal coding-agent work — best balance |
| `every-turn` | After every tool-calling turn | Cache rewritten on almost every turn | Debugging the extension; inspecting summaries |
| `on-context-tag` | When `context_checkpoint` (or legacy `context_tag`) fires | One rewrite per checkpoint | You already use [`pi-context`](https://github.com/ttttmr/pi-context) save-points |
| `on-demand` | Only when you run `/pruner now` | None until you ask | Long investigations; manual control |
| `agentic-auto` | The LLM calls the `context_prune` tool itself | Depends on model discipline | Long autonomous runs after some prompt-tuning |

Why `agent-message` is the default: provider prefix caches (Anthropic, OpenAI, Bedrock, vLLM) only hit when the prompt prefix matches exactly. Every prune rewrites that prefix. Batching tool turns and pruning once per agent reply means roughly one cache miss per task instead of one per turn. See [PRUNING.md § The Sweet Spot](PRUNING.md#the-sweet-spot-batch-and-prune) for the full argument.

## Configuration

Settings live under the `contextPrune` key in `<agent-dir>/settings.json` (i.e. pi's own settings file). `<agent-dir>` is `$PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Each pi preset gets its own settings, so you can run different summarizer models per preset.

```json
{
  "contextPrune": {
    "enabled": false,
    "showPruneStatusLine": true,
    "summarizerModel": "default",
    "summarizerThinking": "default",
    "pruneOn": "agent-message",
    "batchingMode": "turn",
    "remindUnprunedCount": true,
    "quietOversizedSkips": false,
    "minBatchChars": 1000,
    "protectedTools": [],
    "dedupByContentHash": true,
    "chainCompression": {
      "enabled": true,
      "rollingWindow": 3,
      "stripFinalAssistantThinking": true
    },
    "thinkingStrip": {
      "enabled": true,
      "keepLastTurns": 16
    }
  }
}
```

| Key | Values | Default | Notes |
|---|---|---|---|
| `enabled` | `true` / `false` | `false` | Master switch |
| `showPruneStatusLine` | `true` / `false` | `true` | Footer widget + queued-turn notifications |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` | `default` = your active pi model. See [Choosing a summarizer model](#choosing-a-summarizer-model) |
| `summarizerThinking` | `default`/`off`/`minimal`/`low`/`medium`/`high`/`xhigh` | `default` | Provider-specific reasoning effort knob |
| `pruneOn` | see table above | `agent-message` | Trigger mode |
| `batchingMode` | `turn` / `agent-message` | `turn` | How coarse each summary is (independent of `pruneOn`) |
| `remindUnprunedCount` | `true` / `false` | `true` | `agentic-auto` only — appends a tiny `<pruner-note>` reminding the LLM of unpruned count |
| `quietOversizedSkips` | `true` / `false` | `false` | Silences `skipped-oversized` / `skipped-trivial` info notifications |
| `minBatchChars` | non-negative integer, `0` disables | `1000` | Pre-flush guard — batches smaller than this skip the LLM entirely |
| `protectedTools` | `string[]` | `[]` | Never-pruned tool names (e.g. `["todowrite","todoread"]`) |
| `dedupByContentHash` | `true` / `false` | `true` | Re-reads of identical (toolName, content) skip the LLM and alias the original |
| `chainCompression.enabled` | `true` / `false` | `true` | Master toggle for chain-level range compression |
| `chainCompression.rollingWindow` | positive integer | `3` | Keep this many most-recent closed chains raw; compress older ones |
| `chainCompression.stripFinalAssistantThinking` | `true` / `false` | `true` | Strip thinking blocks from the kept final text-only assistant when compressing |
| `purgeErrors.enabled` | `true` / `false` | `true` | Replace failed toolCall argument bodies with compact stubs after cooldown |
| `purgeErrors.cooldownTurns` | positive integer | `2` | Turns to wait after a tool error before purging its argument body |
| `purgeErrors.minArgChars` | non-negative integer | `500` | Only purge arg bodies at least this many characters long |
| `thinkingStrip.enabled` | `true` / `false` | `true` | Strip `thinking` blocks from assistant turns older than the last `keepLastTurns` |
| `thinkingStrip.keepLastTurns` | positive integer | `16` | Keep thinking on the last N assistant turns; strip older. Counts assistant turns, not chains. No-op under N turns |

See [PRUNING.md § Chain Compression](PRUNING.md#chain-compression), [PRUNING.md § Error Purge](PRUNING.md#error-purge), and [PRUNING.md § Main-loop Thinking Strip](PRUNING.md#main-loop-thinking-strip) for the full algorithms.

The three pre-flush features (`minBatchChars`, `protectedTools`, `dedupByContentHash`) are explained in [PRUNING.md § Pre-flush Pipeline & Safeguards](PRUNING.md#pre-flush-pipeline--safeguards). They run BEFORE any summarizer LLM call and can each drop a batch outright while still advancing the prune frontier.

### Choosing a summarizer model

The `default` setting reuses whatever model you have active in pi — convenient but wasteful, since summary writing doesn't need a top-tier coding model. Picking the smallest/fastest model on your plan saves both latency and cost.

| Plan | Suggested summarizer |
|---|---|
| OpenAI / Codex / Copilot | `openai/gpt-4.1-mini`, `google/gemini-2.5-flash`, `xai/grok-3-fast` |
| OpenRouter | `openrouter/qwen/qwen3-30b-a3b` (cheap MoE) |
| Anthropic direct | `anthropic/claude-haiku-3-5` |
| Google AI direct | `google/gemini-2.5-flash` |

Set it from the slash command (saves immediately):

```bash
/pruner model openai/gpt-4.1-mini
/pruner thinking low
# or both in one go:
/pruner model openai/gpt-4.1-mini:low
```

## Commands

| Command | Effect |
|---|---|
| `/pruner` | Interactive picker over all subcommands |
| `/pruner settings` | Settings overlay (toggle / cycle every option) |
| `/pruner on` / `off` | Enable / disable pruning |
| `/pruner status` | Show mode, model, trigger, cumulative stats |
| `/pruner stats` | Detailed cumulative summarizer token/cost stats |
| `/pruner model [id\[:thinking\]]` | Get / set summarizer model (and optionally thinking level) |
| `/pruner thinking [level]` | Get / set summarizer reasoning effort |
| `/pruner prune-on [mode]` | Get / set trigger mode |
| `/pruner batching [mode]` | Get / set batching granularity (`turn` / `agent-message`) |
| `/pruner protected-tools [names]` | Show or edit the never-pruned tool allowlist (comma- or space-separated; `none` clears) |
| `/pruner min-batch-chars [n]` | Show or set the pre-flush trivial-batch threshold (`0` disables) |
| `/pruner dedup [on\|off\|status]` | Toggle pre-flush content-hash dedup |
| `/pruner tree` | Foldable browser of pruned tool calls; `Ctrl-O` opens the full summary in an overlay |
| `/pruner compact` | Retroactively compress every eligible closed chain (bypasses `rollingWindow`) |
| `/pruner now` | Flush pending batches immediately with a multi-row progress widget above the input |
| `/pruner help` | Full help text |

## Tools surfaced to the LLM

**`context_tree_query`** — always available when the extension is loaded. Pruned summaries end with short refs like `Summarized tool refs: \`t1\`, \`t2\`. Use \`context_tree_query\` with these refs to retrieve the original full outputs.` The model passes those refs (or full `toolCallId`s) and gets back the original tool result text from the session index. Content-hash-deduped duplicates resolve to the original's record automatically.

**`context_prune`** — active only when `pruneOn === "agentic-auto"`. The LLM calls it after a meaningful batch of work (the system prompt nudges toward 8–10 tool calls, not every 2–3). The tool flushes every pending batch, streams compact progress into the running tool output box, and returns a `FlushResult` describing how many tool calls were summarized / deduped / skipped.

## Footer status widget

A footer widget shows the current state, controlled by `showPruneStatusLine`:

- `prune: OFF (On agent message)` — disabled, showing what mode would activate
- `prune: ON (On agent message)` — active, no flushes yet
- `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` — active with cumulative input/output tokens and cost
- `prune: 3 pending` — batches queued, waiting for the trigger
- `prune: summarizing…` — flush in progress

Setting `showPruneStatusLine: false` hides the widget and silences the queued-turn notice; pruning still runs.

## Related extensions

- **[pi-context-usage](https://github.com/championswimmer/pi-context-usage)** — visualizes current context size and breaks it down by message type. Useful for seeing how much space pruning saved.
- **[pi-cache-graph](https://github.com/championswimmer/pi-cache-graph)** — plots provider prefix-cache hits/misses in real time. Useful for tuning your `pruneOn` mode against actual cache behavior.

## Limitations

- Pruning only applies to batches captured *while enabled*. Enabling mid-session does not retroactively summarize earlier turns.
- Summarizer calls are synchronous inside `turn_end` (or `message_end` for `agent-message` mode), so they add latency between turns proportional to the summarizer model's response time. Pick a fast model.
- Content-hash dedup only matches against records already in the indexer (cross-flush). Two identical outputs within the *same* flush are not deduped — both go through the summarizer.
- The tree browser does not inline original tool outputs — use `context_tree_query` for that.

## References

- Anthropic prompt caching: <https://docs.claude.com/en/docs/build-with-claude/prompt-caching>
- AWS Bedrock prompt caching: <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>
- OpenAI prompt caching: <https://platform.openai.com/docs/guides/prompt-caching>
- `pi-context` extension (`context_checkpoint` / `context_tag`): <https://github.com/ttttmr/pi-context>
- Research backing summarization-based context management: see [PRUNING.md § Research Evidence](PRUNING.md#why-summarization-works-research-evidence)
