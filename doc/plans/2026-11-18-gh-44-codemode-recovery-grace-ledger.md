# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-gh-44-codemode-recovery-grace.md`
base: 410374ee3245d43ccc709332b1f8608bcac33308
verification: bun test src/
checks: commands
iterations: 4
allowance: 10
returned: 2 | home | 0895d882a92f7e5e357a16ccd30913a81450e4db

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 30 bun test src/pruner.test.ts; 71 passed, 0 failed; scripted results and arguments stay verbatim like direct lookups, including spilled results; ordinary scripts still stub and grace expires at the existing boundary |
| 2 | done | 1 | timeout -k 30 30 bun test src/chain-compressor.test.ts; 54 passed, 0 failed; direct and scripted chains defer through age 3 and become eligible at age 4 while reused-ID neighbors stay eligible; direct-only predicate negative control fails the in-grace script case |
| 3 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: inclusive final turn'; 1 passed, 0 failed; direct@10 and script@11 both returned at age 3 with grace 3 |
| 4 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: first expired turn'; 1 passed, 0 failed; neither key returned at age 4 with grace 3 |
| 5 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'scripted recovery window: zero disables grace'; 1 passed, 0 failed; neither key returned at age 0 with grace 0 |
| 6 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'ignores scripts without a recorded lookup'; 17 passed, 0 failed; malformed, incomplete and near-miss records return only the direct control key |
| 7 | done | 0 | timeout -k 30 30 bun test src/recovery-grace.test.ts --test-name-pattern 'isolates a scripted lookup from a reused ID'; 1 passed, 0 failed; X@11 returned and later X@20 without a lookup excluded |

## Decisions
row 0 done | seeded 5 rows, closed 3 on baseline | row 1: prove scripted output stays verbatim and widen the shared grace check
row 1 done | Widened recovery grace to recorded nested lookups and proved whole-result and argument retention, including spills. | Reuse src/recovery-grace.ts for chain eligibility and src/pruner.test.ts for direct-versus-scripted render fixtures.
row 3 done | Confirmed direct and scripted recovery keys remain in grace on the inclusive final user turn. | nothing new to build on
row 7 done | Confirmed a later result reusing an ID at a different timestamp does not inherit scripted lookup grace. | nothing new to build on
row 2 done | Proved direct and scripted lookup chains defer through the grace boundary, expire together, and leave reused-ID neighbors eligible. | Reuse the parameterized production-boundary fixture in src/chain-compressor.test.ts to check chain eligibility from real messages.
repair verification | home 1bc0ac9 | iteration 4
