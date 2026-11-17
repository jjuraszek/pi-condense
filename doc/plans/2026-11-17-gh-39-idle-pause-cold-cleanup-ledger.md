# Ledger - loop engine
**Spec:** `doc/specs/2026-11-17-gh-39-idle-pause-cold-cleanup.md`
base: e76989b77ea139c728a737cd5c0844350cd09f8a
verification: bun test src/
checks: commands
iterations: 3
allowance: 10
returned: 2 | home | 1a4ad9dac97d8c8dd2833c4ec74ed64ae13518a8

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 13 passed, 0 failed; UI and no-UI human prompts compress all 3 closed chains after 240 minutes; four exceptions and extension or disabled gates preserved |
| 2 | done | 1 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 18 passed, 0 failed; waiting covered reads become placeholders with or without chain compression; a partial covering read leaves the older read unchanged |
| 3 | open | 0 | |
| 4 | done | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 22 passed, 0 failed; open-turn messages and the new prompt equal the render without idle cleanup; existing cold-event floors still activate open-turn reads |
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
row 2 done | Idle cleanup activates covered protected reads in closed chains, including when no chain compresses. | Reuse activateClosedChainSuperseded in src/supersede.ts for replay activation without changing the pending floor.
row 4 done | The open turn and submitted prompt match the render without idle cleanup, including when a cold-event floor is pending. | Reuse the open-turn comparison in src/idle-cleanup.integration.test.ts to check occurrence identity and pending cold floors.
