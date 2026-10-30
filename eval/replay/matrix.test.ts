import { expect, test } from "bun:test";
import { replayMatrix, type ReplayJobs } from "./matrix.js";

test("matrix renders only aggregate cells across model and thinking settings", () => {
  const attempt = (elapsedMs: number) => ({ elapsedMs, notifications: [], records: [{ measurements: { cost: { value: 0.25, provenance: "measured" } } }] });
  const jobs = (model: string, thinking: string, incomplete: boolean): ReplayJobs => ({
    models: [model], thinking, incomplete, exitCode: 2,
    rows: [0, 1].map(i => ({ stem: "SECRET_STEM", batchIndex: i, model, assignment: "candidate=A", selection: [],
      current: { outcome: "retained", text: "SECRET_SUMMARY", attempts: [attempt(i ? 90 : 10)] },
      candidate: { outcome: i ? "error" : "retained", text: i ? undefined : "ok", attempts: [attempt(i ? 80 : 20)] },
      scores: [{ text: "SECRET_ORACLE", resultIndex: 0, resultIndexes: [0], resultLength: 9000, offset: 4500, inMiddle: true, inCurrentInput: true, inCandidateInput: true, retainedCurrent: !i, retainedCandidate: !!i }],
      judge: { verdict: i ? "skipped" : "candidate better", reason: "SECRET_REASON", attempts: [] },
    })) as ReplayJobs["rows"],
  });
  const table = replayMatrix([{ label: "a/model low", jobs: jobs("a/model", "low", false) }, { label: "b/model high", jobs: jobs("b/model", "high", true) }]);
  expect(table.split("\n").filter(line => line.startsWith("|"))).toHaveLength(6);
  expect(table).toContain("| a/model | low | current | 1 / 2 | 1 / 2 | - | - | - | 0 | 10 | 90 | 0.5 | 14 |");
  expect(table).toContain("| a/model | low | candidate | 1 / 2 | 1 / 2 | 1 | 1 | 1 / 0 / 0 | 1 | 20 | 80 | 0.5 | 2 |");
  expect(table).toContain("| b/model (INCOMPLETE) | high | candidate |");
  for (const secret of ["SECRET_ORACLE", "SECRET_STEM", "SECRET_REASON", "SECRET_SUMMARY"]) expect(table).not.toContain(secret);
});
