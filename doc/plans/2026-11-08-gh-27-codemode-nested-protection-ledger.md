# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-27-codemode-nested-protection.md`
base: eb1dd629cf3a6baeb14dac8ef72fa28c2be9ca8e
verification: bun test src/
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 bun test src/protected.test.ts src/batch-capture.test.ts src/chain-detector.test.ts src/pruner.test.ts src/context-metrics.test.ts src/reload-rearm.integration.test.ts eval/replay/extract.test.ts; 219 passed, 0 failed; nested path protection reaches capture, chains, render repair, metrics and replay; no paid or external action launched |
| 2 | done | 0 | timeout -k 30 60 bun test src/protected.test.ts; 22 passed, 0 failed; nested protectedTools matches with absent arguments and empty protectedPaths on any outer tool |
| 3 | done | 0 | timeout -k 30 60 bun test src/protected.test.ts src/reload-rearm.integration.test.ts; 71 passed, 0 failed; incomplete records protect with empty configuration and bypass oversized spill in live capture |
| 4 | done | 0 | timeout -k 30 60 bun test src/protected.test.ts; 32 passed, 0 failed; absent, unmatched and malformed nested records stay prunable while direct protection stays unchanged |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Threaded nested path protection through capture, chains, render repair, metrics and replay with 219 passing tests. | Reuse isProtected's optional nested argument and the live/rescan handler fixture for remaining nested-call cases.
row 2 done | Confirmed nested protected tool names match regardless of arguments or outer tool with path matching disabled. | Reuse the parameterized src/protected.test.ts cases to guard name-only nested protection.
row 3 done | Protected incomplete records unconditionally and verified oversized outputs bypass spill with path matching disabled. | Reuse the incomplete-record matrix and oversized live/rescan fixture to guard fail-closed capture.
row 4 done | Confirmed absent, unmatched and malformed nested records stay prunable while direct matching stays unchanged. | Reuse the src/protected.test.ts compatibility matrix when changing nested metadata handling.
