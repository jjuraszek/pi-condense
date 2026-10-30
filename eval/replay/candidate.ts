import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeBatchForSummarizer } from "../../src/batch-capture.js";
import { SYSTEM_PROMPT } from "../../src/summarizer.js";
import type { CapturedBatch } from "../../src/types.js";
export interface ReplayArm { serialize(batch: CapturedBatch): string; systemPrompt: string }
export const productionArm: ReplayArm = { serialize: serializeBatchForSummarizer, systemPrompt: SYSTEM_PROMPT };
export async function loadCandidate(spec: string | undefined, cwd: string): Promise<{ name: string; arm: ReplayArm }> {
  if (spec === undefined) return { name: "production", arm: productionArm };
  const path = resolve(cwd, spec);
  const module = await import(pathToFileURL(path).href);
  const arm = module.default ?? module.candidate;
  if (!arm || typeof arm.serialize !== "function" || typeof arm.systemPrompt !== "string" || !arm.systemPrompt.trim()) {
    throw Error(`candidate module must export { serialize, systemPrompt }: ${path}`);
  }
  return { name: path, arm };
}
