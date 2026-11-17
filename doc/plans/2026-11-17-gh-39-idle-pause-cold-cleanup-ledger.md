# Ledger - loop engine
**Spec:** `doc/specs/2026-11-17-gh-39-idle-pause-cold-cleanup.md`
base: e76989b77ea139c728a737cd5c0844350cd09f8a
verification: bun test src/
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | 7f8e5c80466773378a3d071c5f2e1beef859d5d6

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 13 passed, 0 failed; UI and no-UI human prompts compress all 3 closed chains after 240 minutes; four exceptions and extension or disabled gates preserved |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 15 passed, 0 failed; a 60-minute pause writes no chain entry in UI and no-UI sessions; first-request messages equal the pre-cleanup render |
| 6 | open | 0 | |
| 7 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 13 passed, 0 failed; a new extension instance reconstructs a 240-minute-old branch at session_start; its first UI or no-UI prompt compresses all 3 chains |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | open | 0 | |
| 11 | open | 0 | |
| 12 | open | 0 | |
| 13 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: extend src/idle-cleanup.integration.test.ts and wire the idle check before the first request
row 1 done | Human prompts after 180 idle minutes compress closed chains before the first request while preserving all four exceptions. | Reuse src/idle-pause.ts for the pause clock and the boot, submit, and request fixture in src/idle-cleanup.integration.test.ts for handler checks.
row 7 done | The handler check proves a fresh extension instance cleans a rebuilt 240-minute-old branch on its first UI or no-UI prompt. | nothing new to build on
row 5 done | A 60-minute pause leaves the first-request render unchanged in UI and no-UI sessions. | Reuse the below-threshold case in src/idle-cleanup.integration.test.ts to compare request messages across idle gating.
