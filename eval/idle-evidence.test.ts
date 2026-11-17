import { expect, test } from "bun:test";
import { checkIdleEvidence, type EvidenceIO } from "./idle-evidence";
import { corpusHash, IDLE_PIPELINE_SETTINGS, JUDGE_MODEL, RUNS_PER_CASE, settingsHash, SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, subjectPromptHash, SUMMARIZER_MODELS } from "./config";
import { judgePromptHash } from "./judge";
import { renderReport, type Report } from "./report";
import type { Scenario } from "./scenario";

function fixture() {
  const scenarios: Scenario[] = [
    { id: "fresh", title: "Fresh", tests: "skill", history: [], probe: "B", mechanical: {} },
    { id: "paused", title: "Paused", tests: "skill", history: [], probe: "B", mechanical: {}, twinOf: "fresh", seedAgeMinutes: 240 },
  ];
  const files = scenarios.map(s => ({ path: `${s.id}.ts`, bytes: `fixture ${s.id}` }));
  const versions = { sdk: "1" };
  const report: Report = {
    revision: "a".repeat(40), date: "2026-11-17", versions,
    settings: { ...IDLE_PIPELINE_SETTINGS, summarizerModel: SUMMARIZER_MODELS[0] },
    key: { SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, subjectPromptHash: subjectPromptHash(), summarizer: SUMMARIZER_MODELS[0], JUDGE_MODEL, judgePromptHash: judgePromptHash(), settingsHash: settingsHash(IDLE_PIPELINE_SETTINGS), corpusHash: corpusHash(files), RUNS_PER_CASE },
    scenarios,
    jobs: scenarios.flatMap(s => Array.from({ length: RUNS_PER_CASE }, (_, runIndex) => ({ scenario: s.id, runIndex, status: "ok", verdict: "pass" }))),
  };
  const calls: string[][] = [];
  const io: EvidenceIO = {
    read: async path => path === "/report.md" ? renderReport(report) : files.find(f => path === `/repo/eval/scenarios-idle/${f.path}`)!.bytes,
    git: async args => { calls.push(args); return ""; },
    versions: () => versions,
  };
  return { report, files, io, calls };
}

test("replays a complete comparison against its unchanged committed candidate", async () => {
  const h = fixture();
  expect(await checkIdleEvidence("/report.md", "fresh", "/repo", h.io)).toBe("fresh: fresh 3/3, paused 3/3 PASS");
  expect(h.calls[0]).toEqual(expect.arrayContaining(["diff", "--exit-code", h.report.revision, "--", "index.ts", "src", "eval/session.ts", "eval/scenarios-idle/fresh.ts", "eval/scenarios-idle/paused.ts"]));
  expect(h.calls[0]).not.toContain("doc/plans");
  expect(h.calls[1]).toEqual(expect.arrayContaining(["ls-files", "--others", "--exclude-standard"]));
});

test.each([
  ["missing report", "missing"], ["malformed report", "metadata"], ["missing pair", "pair"],
  ["incomplete", "incomplete"], ["duplicate job", "incomplete"], ["errored", "incomplete"],
  ["inconclusive", "INCONCLUSIVE"], ["regression", "REGRESSION CANDIDATE"],
  ["one run", "comparison key"], ["wrong model", "comparison key"],
  ["changed fixture", "comparison key"], ["changed settings", "settings"],
  ["changed SDK", "SDK"], ["invalid revision", "revision"],
  ["stale source", "candidate"], ["untracked source", "candidate"],
  ["wrong idle arm", "age"],
])("refuses %s evidence", async (defect, reason) => {
  const h = fixture();
  let pair = "fresh";
  if (defect === "missing report") h.io.read = async () => { throw Error("missing report"); };
  if (defect === "malformed report") h.io.read = async () => "not a report";
  if (defect === "missing pair") pair = "absent";
  if (defect === "incomplete") h.report.jobs.pop();
  if (defect === "duplicate job") h.report.jobs[1] = h.report.jobs[0];
  if (defect === "errored") h.report.jobs[0].status = "error";
  if (defect === "inconclusive") h.report.jobs[0].verdict = "fail";
  if (defect === "regression") h.report.jobs.at(-1)!.verdict = "fail";
  if (defect === "one run") { h.report.key.RUNS_PER_CASE = 1; h.report.jobs = h.report.jobs.filter(j => j.runIndex === 0); }
  if (defect === "wrong model") h.report.key.SUBJECT_MODEL = "different";
  if (defect === "changed fixture") h.files[0].bytes = "changed";
  if (defect === "changed settings") h.report.settings = {};
  if (defect === "changed SDK") h.report.versions = { sdk: "2" };
  if (defect === "invalid revision") h.report.revision = "HEAD";
  if (defect === "stale source") h.io.git = async () => { throw Error("source differs"); };
  if (defect === "untracked source") h.io.git = async args => args[0] === "ls-files" ? "src/new.ts\n" : "";
  if (defect === "wrong idle arm") h.report.scenarios[1].seedAgeMinutes = 0;
  await expect(checkIdleEvidence("/report.md", pair, "/repo", h.io)).rejects.toThrow(reason);
});
