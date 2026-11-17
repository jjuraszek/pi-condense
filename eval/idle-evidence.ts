import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { corpusHash, IDLE_PIPELINE_SETTINGS, JUDGE_MODEL, RUNS_PER_CASE, settingsHash, stableHash, SUBJECT_MODEL, SUBJECT_THINKING_LEVEL, subjectPromptHash, SUMMARIZER_MODELS } from "./config";
import { judgePromptHash } from "./judge";
import { compareIdleTwins, readReport } from "./report";
import { installedVersions } from "./run";

export interface EvidenceIO {
  read(path: string): Promise<string>;
  git(args: string[]): Promise<string>;
  versions(): Record<string, string>;
}
const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

export async function checkIdleEvidence(path: string, pair: string, repo = repoDefault, io: EvidenceIO = {
  read: path => readFile(path, "utf8"),
  git: async args => (await exec("timeout", ["-k", "30", "10", "git", "-C", repo, ...args])).stdout,
  versions: installedVersions,
}): Promise<string> {
  const report = readReport(await io.read(path));
  if (!/^[a-f0-9]{40}$/.test(report.revision)) throw Error("Invalid candidate revision");
  if (!report.scenarios.some(s => s.id === pair && !s.twinOf)) throw Error("Missing requested idle pair");
  const comparison = compareIdleTwins(report);
  if (comparison.exitCode) throw Error(comparison.text);
  if (report.scenarios.some(s => !/^[a-z-]+$/.test(s.id) || (s.seedAgeMinutes ?? 0) !== (s.twinOf ? 240 : 0))) throw Error("Invalid idle scenario id or age");
  const files = await Promise.all(report.scenarios.map(async s => ({ path: `${s.id}.ts`, bytes: await io.read(join(repo, "eval/scenarios-idle", `${s.id}.ts`)) })));
  const expectedKey = {
    SUBJECT_MODEL, subjectPromptHash: subjectPromptHash(), SUBJECT_THINKING_LEVEL,
    summarizer: SUMMARIZER_MODELS[0], JUDGE_MODEL, judgePromptHash: judgePromptHash(),
    settingsHash: settingsHash(IDLE_PIPELINE_SETTINGS), corpusHash: corpusHash(files), RUNS_PER_CASE,
  };
  if (stableHash(report.key) !== stableHash(expectedKey)) throw Error("Stale idle comparison key");
  if (stableHash(report.settings) !== stableHash({ ...IDLE_PIPELINE_SETTINGS, summarizerModel: SUMMARIZER_MODELS[0] })) throw Error("Stale idle settings");
  if (stableHash(report.versions) !== stableHash(io.versions())) throw Error("Stale idle SDK versions");
  // Check executed inputs, not ledger/docs or this offline reader. Unrelated new pairs can reuse an unchanged pair's result.
  const inputs = ["index.ts", "src", "package.json", "package-lock.json", "bun.lock", "bun.lockb",
    "eval/config.ts", "eval/judge.ts", "eval/observer.ts", "eval/report.ts", "eval/run.ts", "eval/scenario.ts", "eval/session.ts",
    ...files.map(f => `eval/scenarios-idle/${f.path}`)];
  try {
    await io.git(["diff", "--exit-code", "--quiet", report.revision, "--", ...inputs]);
    if ((await io.git(["ls-files", "--others", "--exclude-standard", "--", ...inputs])).trim()) throw Error("Untracked inputs");
  } catch { throw Error("Stale candidate code or fixtures; evaluate a clean committed candidate"); }
  return comparison.text;
}

if (import.meta.main) {
  const [path, pair, ...extra] = process.argv.slice(2);
  try {
    if (!path || !pair || extra.length) throw Error("Usage: bun eval/idle-evidence.ts <report.md> <fresh-scenario-id>");
    console.log(await checkIdleEvidence(path, pair));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
