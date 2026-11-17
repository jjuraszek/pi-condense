# Ledger - loop engine
**Spec:** `doc/specs/2026-11-17-gh-39-idle-pause-cold-cleanup.md`
base: e76989b77ea139c728a737cd5c0844350cd09f8a
verification: bun test src/
checks: commands
iterations: 1
allowance: 10
returned: seed | home | 0cd02b3d8a85f03c97137bd4ea04c00f8adb5b9f

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 bun test ./src/idle-cleanup.integration.test.ts; 0 passed, 2 failed; UI and no-UI first prompts after 240 minutes wrote 0 chain entries, expected 3 |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | open | 0 | |
| 11 | open | 0 | |
| 12 | open | 0 | |
| 13 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1: extend src/idle-cleanup.integration.test.ts and wire the idle check before the first request
