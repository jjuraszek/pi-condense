# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-gh-44-codemode-recovery-grace.md`
base: 410374ee3245d43ccc709332b1f8608bcac33308
verification: bun test src/
checks: commands
iterations: 1
allowance: 10
returned: seed | home | 4c3308e8c5399aa1e6f5708bfca60e2fa5b93edd

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | open | 0 | |
| 3 | open | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: inclusive final turn'; 0 passed, 1 failed; expected direct@10 and script@11, received only direct@10 |
| 4 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: first expired turn'; 1 passed, 0 failed; neither key returned at age 4 with grace 3 |
| 5 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: zero disables grace'; 1 passed, 0 failed; neither key returned at age 0 with grace 0 |
| 6 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'ignores scripts without a recorded lookup'; 17 passed, 0 failed; malformed, incomplete and near-miss records return only the direct control key |
| 7 | open | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'isolates a scripted lookup from a reused ID'; 0 passed, 1 failed; expected X@11 only, received an empty set |

## Decisions
row 0 done | seeded 5 rows, closed 3 on baseline | row 1: prove scripted output stays verbatim and widen the shared grace check
