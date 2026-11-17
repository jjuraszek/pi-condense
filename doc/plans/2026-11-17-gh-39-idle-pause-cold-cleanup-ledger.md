# Ledger - loop engine
**Spec:** `doc/specs/2026-11-17-gh-39-idle-pause-cold-cleanup.md`
base: e76989b77ea139c728a737cd5c0844350cd09f8a
verification: bun test src/
checks: commands
iterations: 15
allowance: 10
returned: 13 | home | f0353152cde87df43ab5d0d6ede257f4676d3f34

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 13 passed, 0 failed; UI and no-UI human prompts compress all 3 closed chains after 240 minutes; four exceptions and extension or disabled gates preserved |
| 2 | done | 1 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 18 passed, 0 failed; waiting covered reads become placeholders with or without chain compression; a partial covering read leaves the older read unchanged |
| 3 | done | 1 | timeout -k 30 120 bun test src/idle-cleanup.integration.test.ts; 25 passed, 0 failed; idle summaries and protected outputs stay literal before and after reload; manual compact still fuses and substitutes nested references |
| 4 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 22 passed, 0 failed; open-turn messages and the new prompt equal the render without idle cleanup; existing cold-event floors still activate open-turn reads |
| 5 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 15 passed, 0 failed; a 60-minute pause writes no chain entry in UI and no-UI sessions; first-request messages equal the pre-cleanup render |
| 6 | done | 1 | timeout -k 30 60 bun test ./src/idle-pause.test.ts ./src/idle-cleanup.integration.test.ts; 41 passed, 0 failed; a 60-minute-old cache_warm preserves the first request in UI and no-UI sessions; both refresh kinds use ISO entry timestamps and the newest refresh wins |
| 7 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 13 passed, 0 failed; a new extension instance reconstructs a 240-minute-old branch at session_start; its first UI or no-UI prompt compresses all 3 chains |
| 8 | done | 0 | timeout -k 30 60 bun test ./src/idle-pause.test.ts ./src/idle-cleanup.integration.test.ts; 54 passed, 0 failed; longer declared lifetimes delay cleanup with strict boundary checks; the real helper selects long only for PI_CACHE_RETENTION=long and short for short, none, or unset |
| 9 | done | 0 | timeout -k 30 60 bun test ./src/idle-pause.test.ts ./src/idle-cleanup.integration.test.ts; 58 passed, 0 failed; no declared lifetime keeps a 60-minute request unchanged and compresses after 240 minutes; the handler uses the threshold when promptCache or its active retention tier is missing |
| 10 | done | 2 | timeout -k 30 60 bun test ./src/config.test.ts ./src/commands.test.ts ./src/idle-cleanup.integration.test.ts; 130 passed, 0 failed; invalid array settings fall back to 180 without a callback timeout; custom durations and all four settings presets pass |
| 11 | done | 2 | timeout -k 30 30 bun eval/idle-evidence.ts "${TMPDIR:-/tmp}/pi-condense-eval-au4zjE/claude-haiku-5-5.md" skill-gate-reply; fresh 3/3, paused 3/3, zero retries; paid npm run eval -- --idle --summarizer anthropic/claude-haiku-5-5 --change "idle cleanup twins" passed on clean candidate 037ef22620b997b4fa5cdfd0ee7fe4042f04545f; 18 offline validation cases passed, including stale, incomplete, inconclusive, and regressing evidence |
| 12 | done | 4 | timeout -k 30 30 bun eval/idle-evidence.ts "${TMPDIR:-/tmp}/pi-condense-eval-cbQxsB/claude-haiku-5-5.md" plan-progress-continue; fresh 3/3, paused 3/3, zero retries; paid npm run eval -- --idle --summarizer anthropic/claude-haiku-5-5 --change "idle cleanup twins" exited 0 on clean candidate 8cd74a4a20cf09e1498cddbe2333214ffda04d99; all three paused first requests carry three compressed chains with the latest plan_tracker text in a protected-output block |
| 13 | done | 1 | timeout -k 30 10 python3 -c 'assert all(text in __import__("pathlib").Path("PRUNING.md").read_text() for text in ("sixth cold moment", "### Idle cleanup", "idleCleanupMinutes", "cache_warm", "word for word", "literalSummary", "never-summarized"))'; 7 documentation assertions passed; 0 failures |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: extend src/idle-cleanup.integration.test.ts and wire the idle check before the first request
row 1 done | Human prompts after 180 idle minutes compress closed chains before the first request while preserving all four exceptions. | Reuse src/idle-pause.ts for the pause clock and the boot, submit, and request fixture in src/idle-cleanup.integration.test.ts for handler checks.
row 7 done | The handler check proves a fresh extension instance cleans a rebuilt 240-minute-old branch on its first UI or no-UI prompt. | nothing new to build on
row 5 done | A 60-minute pause leaves the first-request render unchanged in UI and no-UI sessions. | Reuse the below-threshold case in src/idle-cleanup.integration.test.ts to compare request messages across idle gating.
row 2 done | Idle cleanup activates covered protected reads in closed chains, including when no chain compresses. | Reuse activateClosedChainSuperseded in src/supersede.ts for replay activation without changing the pending floor.
row 4 done | The open turn and submitted prompt match the render without idle cleanup, including when a cold-event floor is pending. | Reuse the open-turn comparison in src/idle-cleanup.integration.test.ts to check occurrence identity and pending cold floors.
row 3 done | Idle compression preserves summary and protected-output bytes across reload without fusing, while manual compact keeps its rendering. | Reuse ChainCompressionEntry.literalSummary for durable literal rendering and summarizedBranch in src/idle-cleanup.integration.test.ts for protected-output checks.
row 6 done | Cache-warm entries restart the idle clock, and both request kinds use ISO entry timestamps rather than assistant message timestamps. | Reuse src/idle-pause.test.ts clock fixtures and the cache-warm integration cases to check pause timing without model calls.
row 8 done | Checks prove longer declared cache lifetimes delay cleanup through the real helper and restore the retention environment after each case. | Reuse the declared-lifetime matrix in src/idle-cleanup.integration.test.ts for isolated retention-tier checks.
row 9 done | Checks prove the threshold alone controls cleanup when a model lacks a cache lifetime for the active retention tier. | Reuse the undeclared-lifetime cases in src/idle-cleanup.integration.test.ts for models missing promptCache or its long tier.
row 10 failed | Added threshold normalization, settings presets, and custom-duration checks, but the empty-array config case timed out after 5 s. | Keep the implementation and docs, wrap invalid inputs in object cases to avoid Bun's done-callback interpretation of [], then rerun the three-file check.
row 10 done | Wrapped invalid thresholds in object cases, fixing the array-case timeout and passing all 130 configuration, settings, and idle-cleanup checks. | Reuse src/config.test.ts object-wrapped cases to check invalid array inputs without Bun interpreting them as callback tests.
row 11 failed | Added idle skill twins, isolated runner settings, and request-arm proofs with 127 passing offline checks, but the paid comparison requires a clean tree. | Run --idle from the clean committed checkout before redispatch; reuse compareIdleTwins in eval/report.ts for local report checks.
amended | 1 item(s) | Clean candidate eval checkout
row 11 done | The skill-reply twins pass 3/3 each on a clean committed candidate, and offline validation rejects stale or incomplete reports. | Reuse eval/idle-evidence.ts with the saved report path and a fresh scenario ID to validate twins without paid calls.
row 12 failed | Added workflow twins covering summarized, zero-summary, and interrupted partial chains, but the saved paid report lacks the workflow pair. | Keep the twins and 7 passing fixture checks; run --idle from this committed candidate, then validate plan-progress-continue with eval/idle-evidence.ts.
row 12 failed | Two clean-candidate idle runs confirmed workflow regression: fresh 3/3, paused 0/3, while skill twins stayed 3/3. | Keep both reports; fix lost unsummarized tracker state in partly summarized chains without weakening the twins or repeating the unchanged paid comparison.
amended | 1 item(s) | Retain never-summarized result text
row 12 failed | Retained unsummarized tracker text through reload with 97 passing checks, but paid workflow evidence still predates the repair. | Keep the repair and unchanged twins; run --idle from this committed candidate and validate plan-progress-continue with eval/idle-evidence.ts.
row 12 escalated | implModel round | allowed attempts 10
row 12 done | Workflow twins score fresh 3/3 and paused 3/3 on clean candidate 8cd74a4, with the latest tracker text retained in all three paused first requests. | Reuse the cbQxsB report with eval/idle-evidence.ts for both pairs; row 11's au4zjE report is now stale, and eval/session.ts still lacks the in-chain retained-text proof the spec table names.
row 13 done | Documented the idle threshold, cache-refresh clock, literal retention, closed-turn supersession, settings, and targeted eval limits. | Reuse PRUNING.md#idle-cleanup; idle replay and failure diagnostics still need code before their documentation can be added.
repair verification | home 6261799 | iteration 15
