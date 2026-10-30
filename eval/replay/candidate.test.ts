import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCandidate, productionArm } from "./candidate.js";
import { serializeBatchForSummarizer } from "../../src/batch-capture.js";
import { SYSTEM_PROMPT } from "../../src/summarizer.js";

test("default candidate is production", async () => {
  expect(await loadCandidate(undefined, process.cwd())).toEqual({ name: "production", arm: productionArm });
  expect(productionArm.serialize).toBe(serializeBatchForSummarizer);
  expect(productionArm.systemPrompt).toBe(SYSTEM_PROMPT);
});

test.each(["default", "candidate"])("loads a distinct %s export relative to cwd", async kind => {
  const dir = mkdtempSync(join(tmpdir(), "replay-candidate-"));
  const file = join(dir, "arm.mjs");
  writeFileSync(file, `export ${kind === "default" ? "default" : "const candidate ="} { serialize: () => "marker", systemPrompt: "experiment" };`);
  const loaded = await loadCandidate("arm.mjs", dir);
  expect(loaded.name).toBe(file);
  expect(loaded.arm.systemPrompt).toBe("experiment");
  expect(loaded.arm.systemPrompt).not.toBe(SYSTEM_PROMPT);
});

test("rejects a module missing serialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-candidate-"));
  const file = join(dir, "invalid.mjs");
  writeFileSync(file, 'export default { systemPrompt: "experiment" };');
  await expect(loadCandidate(file, dir)).rejects.toThrow(`candidate module must export { serialize, systemPrompt }: ${file}`);
});
