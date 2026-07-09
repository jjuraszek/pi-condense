# Configuration reference

Full `contextPrune` settings, commands, footer widget states, spilled outputs,
and the summarizer-model-by-plan table. See the [README](../README.md) for the
6 knobs most people touch and the conceptual model; see
[PRUNING.md](../PRUNING.md) for the algorithm behind each setting.

## Full settings JSON

Settings live under the `contextPrune` key in `<agent-dir>/settings.json` (i.e. pi's own settings file). `<agent-dir>` is `$PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Each pi preset gets its own settings, so you can run different summarizer models per preset.

```json
{
  "contextPrune": {
    "enabled": false,
    "showPruneStatusLine": true,
    "summarizerModel": "default",
    "summarizerThinking": "default",
    "summarizerIdleTimeoutMs": 20000,
    "summarizerMaxTimeoutMs": 180000,
    "pruneOn": "agent-message",
    "batchingMode": "turn",
    "quietOversizedSkips": false,
    "minBatchChars": 1000,
    "recoveryGraceTurns": 3,
    "protectedTools": [],
    "protectedPaths": ["**/skills/**/*.md"],
    "dedupByContentHash": true,
    "autoBudgetThreshold": null,
    "spillThreshold": 65536,
    "spillPreviewBytes": 2048,
    "budgetTurnDelta": null,
    "chainCompression": {
      "enabled": true,
      "rollingWindow": 3,
      "stripFinalAssistantThinking": true,
      "fuseRangeSummary": true
    },
    "thinkingStrip": {
      "enabled": true,
      "keepLastTurns": 16
    }
  }
}
```

## Every key

| Key | Values | Default | Notes |
|---|---|---|---|
| `enabled` | `true` / `false` | `false` | Master switch |
| `showPruneStatusLine` | `true` / `false` | `true` | Footer widget + queued-turn notifications |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` | `default` = your active pi model. See [Choosing a summarizer model](#choosing-a-summarizer-model) |
| `summarizerThinking` | `default`/`off`/`minimal`/`low`/`medium`/`high`/`xhigh` | `default` | Provider-specific reasoning effort knob |
| `pruneOn` | `agent-message` / `on-demand` | `agent-message` | Trigger mode - see README Architecture section |
| `batchingMode` | `turn` / `agent-message` | `turn` | How coarse each summary is (independent of `pruneOn`) |
| `quietOversizedSkips` | `true` / `false` | `false` | Silences `skipped-oversized` / `skipped-trivial` info notifications |
| `minBatchChars` | non-negative integer, `0` disables | `1000` | Pre-flush guard - batches smaller than this skip the LLM entirely |
| `recoveryGraceTurns` | non-negative integer (user-turn-groups), `0` disables | `3` | After a `context_tree_query` recovery, render that tool's output verbatim for this many user-turn-groups before re-stubbing it. Enforced at render time (Phase 1 + chain-compression eligibility), not at capture time. See [PRUNING.md § What Pruning Does](../PRUNING.md#what-pruning-does) |
| `summarizerIdleTimeoutMs` | non-negative integer (ms), `0` disables | `20000` | Abort a summarizer stream call after this much silence (no stream event). Resets on every event, so it never false-aborts a flowing generation; catches a stalled connection fast. A timeout feeds the same outage-fallback retry as a provider error. `0` = no idle bound. |
| `summarizerMaxTimeoutMs` | non-negative integer (ms), `0` disables | `180000` | Hard ceiling on total duration of a single summarizer stream call. Backstop for a stream that dribbles forever without going idle. Generous by design (clears the observed p99). `0` = no ceiling. |
| `protectedTools` | `string[]` | `[]` | Never-pruned tool names (e.g. `["todowrite","todoread"]`). When a protected tool's chain is range-compressed, its output is preserved verbatim inside the `<compressed-chain>` block as `<protected-output>` - protected outputs are never lost. |
| `protectedPaths` | `string[]` | `["**/skills/**/*.md"]` | Globs matched against a tool call's `args.path`; matching outputs are never pruned (same semantics as `protectedTools`, including `<protected-output>` relocation in compressed chains). Already-summarized matching reads are repaired on the next turn; chain-compressed ones are not. Set `[]` to disable. |
| `dedupByContentHash` | `true` / `false` | `true` | Re-reads of identical (toolName, content) skip the LLM and alias the original |
| `autoBudgetThreshold` | fraction `0`-`1`, or `null` | `null` | Token-budget auto-flush: force a prune when context usage reaches this share of the window, regardless of `pruneOn`. `0.8` = 80%, not `80`. `null` = off. See [Token-budget auto-flush](#token-budget-auto-flush) |
| `spillThreshold` | positive integer | `65536` | Minimum chars (`resultText.length`) for a single tool result to be spilled eagerly to a sidecar file at capture time rather than waiting for normal summarization. Non-positive / invalid values fall back to the default; to effectively disable spilling, set it above any result you expect. See [Spilled outputs](#spilled-outputs) |
| `spillPreviewBytes` | non-negative integer | `2048` | Head preview (bytes) kept inline in the stub and index record for a spilled result. Full body is on disk. |
| `budgetTurnDelta` | fraction `0`-`1`, or `null` | `null` | Force a flush when a single turn's context-usage fraction jumps by at least this amount, ORed with `autoBudgetThreshold`. Catches sudden spikes a static threshold would miss until the next turn. `null` = off. |
| `chainCompression.enabled` | `true` / `false` | `true` | Master toggle for chain-level range compression |
| `chainCompression.rollingWindow` | positive integer | `3` | Keep this many most-recent closed chains raw; compress older ones |
| `chainCompression.stripFinalAssistantThinking` | `true` / `false` | `true` | Strip thinking blocks from the kept final text-only assistant when compressing |
| `chainCompression.fuseRangeSummary` | `true` / `false` | `true` | Fuse a compressed chain's per-batch summaries into one cohesive LLM summary (one extra summarizer call per multi-batch span); off keeps the per-batch concatenation |
| `purgeErrors.enabled` | `true` / `false` | `true` | Replace failed toolCall argument bodies with compact stubs after cooldown |
| `purgeErrors.cooldownTurns` | positive integer | `2` | Turns to wait after a tool error before purging its argument body |
| `purgeErrors.minArgChars` | non-negative integer | `500` | Only purge arg bodies at least this many characters long |
| `thinkingStrip.enabled` | `true` / `false` | `true` | Strip `thinking` blocks from assistant turns older than the last `keepLastTurns` |
| `thinkingStrip.keepLastTurns` | positive integer | `16` | Keep thinking on the last N assistant turns; strip older. Counts assistant turns, not chains. No-op under N turns |

See [PRUNING.md § Chain Compression](../PRUNING.md#chain-compression), [PRUNING.md § Error Purge](../PRUNING.md#error-purge), and [PRUNING.md § Main-loop Thinking Strip](../PRUNING.md#main-loop-thinking-strip) for the full algorithms.

The three pre-flush features (`minBatchChars`, `protectedTools`, `dedupByContentHash`) are explained in [PRUNING.md § Pre-flush Pipeline & Safeguards](../PRUNING.md#pre-flush-pipeline--safeguards). They run BEFORE any summarizer LLM call and can each drop a batch outright while still advancing the prune frontier.

### Token-budget auto-flush

When `autoBudgetThreshold` is set to a value in `(0, 1]`, the extension checks context usage at the end of every tool-using turn. If `tokens / contextWindow` reaches the threshold, ALL pending batches are flushed immediately - regardless of `pruneOn` mode. This is an **additional** trigger layered on top of `pruneOn`, not a replacement.

- `0.8` means 80% of the context window - it is a **fraction**, not a percentage. `0.8 != 80`.
- The trigger is a no-op when `tokens` is `null` (right after a provider-side compaction); it resumes once usage is known again.
- Editable live via `/pruner settings` (row "Auto-flush at context %", presets Off / 60 / 70 / 80 / 90%).
- Default `null` = off.

Inspired by DCP's `maxContextLimit` nudging; simplified to a single threshold that forces a flush rather than separate nudge/force levels.

### Spilled outputs

Single tool results larger than `spillThreshold` chars are written to `<session-dir>/<sessionId>-blobs/<toolCallId>.txt` at capture time and replaced in context with a short stub (tool name, byte size, head preview, file path). The full body is recoverable via the native `read` tool at the embedded path (offset/limit supported) or via `context_tree_query` by id, which falls back to the inline preview if the sidecar is missing. Moving a session `.jsonl` without its `-blobs/` directory loses only the giant-blob recovery path; bodies under `spillThreshold` stay inline in the index entry as usual.

### Choosing a summarizer model

The `default` setting reuses whatever model you have active in pi - convenient but wasteful, since summary writing doesn't need a top-tier coding model. Picking the smallest/fastest model on your plan saves both latency and cost.

If the configured summarizer model suffers a transient outage while your active pi model is healthy, pi-condense automatically falls back to the session model for the duration (with a one-time notice) and probes the configured model back every few minutes - no configuration needed.

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

### Summarizer timeouts

Every summarizer call is bounded by two independent timers, so a stalled
provider connection can never hang the agent turn:

- **Idle timeout** (`summarizerIdleTimeoutMs`, default 20s) - resets on every
  stream event, including reasoning/`thinking` events, so a long-but-flowing
  generation is never cut off. It also bounds time-to-first-token. This is
  the primary guard against a silent hang.
- **Total-duration ceiling** (`summarizerMaxTimeoutMs`, default 180s) - a hard
  upper bound that catches a stream which keeps dribbling events but never
  finishes. Generous by design; a pure backstop.

A timeout is treated exactly like a transient provider error: it feeds the
outage-fallback retry, so if a distinct `summarizerModel` is configured the
stalled call is retried once on the session model (itself timeout-bounded).
Both timers can be set to `0` to disable them independently.

## Commands

| Command | Effect |
|---|---|
| `/pruner` | Interactive picker over all subcommands |
| `/pruner settings` | Settings overlay (toggle / cycle every option) |
| `/pruner on` / `off` | Enable / disable pruning |
| `/pruner status` | Show mode, model, trigger, cumulative stats |
| `/pruner stats` | Detailed cumulative summarizer token/cost stats |
| `/pruner model [id[:thinking]]` | Get / set summarizer model (and optionally thinking level) |
| `/pruner thinking [level]` | Get / set summarizer reasoning effort |
| `/pruner prune-on [mode]` | Get / set trigger mode |
| `/pruner batching [mode]` | Get / set batching granularity (`turn` / `agent-message`) |
| `/pruner protected-tools [names]` | Show or edit the never-pruned tool allowlist (comma- or space-separated; `none` clears) |
| `/pruner protected-paths [globs]` | Show or edit the never-pruned path globs (`none` clears) |
| `/pruner min-batch-chars [n]` | Show or set the pre-flush trivial-batch threshold (`0` disables) |
| `/pruner recovery-grace [n]` | Show or set the post-recovery verbatim grace window, in user-turn-groups (`0` disables) |
| `/pruner dedup [on\|off\|status]` | Toggle pre-flush content-hash dedup |
| `/pruner tree` | Foldable browser of pruned tool calls; `Ctrl-O` opens the full summary in an overlay |
| `/pruner compact` | Retroactively compress every eligible closed chain (bypasses `rollingWindow`) |
| `/pruner now` | Flush pending batches immediately with a multi-row progress widget above the input |
| `/pruner help` | Full help text |

## Tools surfaced to the LLM

**`context_tree_query`** - always available when the extension is loaded. Pruned summaries end with short refs like `Summarized tool refs: \`t1\`, \`t2\`. Use \`context_tree_query\` with these refs to retrieve the original full outputs.` The model passes those refs (or full `toolCallId`s) and gets back the original tool result text from the session index. Each per-tool bullet in the summary also carries its own inline `` `tN` `` ref, so recovering a specific tool is a single hop; the footer still lists every ref as a fallback. Content-hash-deduped duplicates resolve to the original's record automatically.

## Footer status widget

A footer widget shows the current state, controlled by `showPruneStatusLine`:

Every rendered state is wrapped in `| ... |` so the segment stays visually isolated in the shared footer regardless of where other extensions' status segments land (load-order independent).

- `| prune: OFF |` - disabled
- `| prune: ON |` - enabled, no flushes yet
- `| prune: ON . 92k->14k (-85%) |` - enabled; live reclaim ratio (estimated tokens before->after, percent reduction). Updates on every `pruneMessages` call.
- `| prune: 3 pending |` - batches queued, waiting for the trigger
- `| prune: summarizing... |` - flush in progress

Setting `showPruneStatusLine: false` hides the widget and silences the queued-turn notice; pruning still runs.

Cost no longer appears on the status line. Full token/cost detail is available via `/pruner stats`. The extension also emits cumulative session cost on the `cost:external` pi.events channel for external aggregators - see [README § External cost channel](../README.md#external-cost-channel).
