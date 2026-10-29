import { createHash } from "node:crypto";

export const SUBJECT_MODEL = "anthropic/claude-sonnet-5-5";
export const SUBJECT_THINKING_LEVEL = "medium";
export const SUBJECT_SYSTEM_PROMPT = "You are the coding assistant for the fictional orbital-ledger project. Answer the user's current request using the conversation and available evidence. Distinguish facts from hypotheses, respect corrections and approvals, and recover original tool results when you need their evidence.";
export const SUMMARIZER_MODELS = ["anthropic/claude-haiku-5-5", "github-copilot/gpt-6-luna"] as const;
export const JUDGE_MODEL = "anthropic/claude-opus-5-5";
export const RUNS_PER_CASE = 3;
export const DEFAULT_CONCURRENCY = 8;
export const RETRY_POLICY = { retries: 2, backoffMs: [2000, 8000], only: ["http-429", "transport"] } as const;
export const PIPELINE_SETTINGS = {
  enabled: true,
  showPruneStatusLine: true,
  summarizerModel: "",
  summarizerThinking: "default",
  pruneOn: "agent-message",
  batchingMode: "turn",
  quietOversizedSkips: false,
  minBatchChars: 2000,
  recoveryGraceTurns: 3,
  summarizerIdleTimeoutMs: 45000,
  summarizerMaxTimeoutMs: 180000,
  protectedTools: [],
  protectedPaths: ["**/skills/**/*.md", "**/gauntlet-overrides.md"],
  chainCompression: { enabled: true, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: true },
  purgeErrors: { enabled: true, cooldownTurns: 2, minArgChars: 500 },
  dedupByContentHash: true,
  autoBudgetThreshold: null,
  spillThreshold: 65536,
  spillPreviewBytes: 2048,
  budgetTurnDelta: null,
  frontierGapThresholdTokens: null,
  maxImagesPerRequest: null,
} as const;

export function concurrency(env = process.env): number {
  const value = Number(env.EVAL_CONCURRENCY ?? DEFAULT_CONCURRENCY);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("EVAL_CONCURRENCY must be a positive integer");
  return value;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

export function settingsHash(settings: Record<string, unknown> = PIPELINE_SETTINGS): string {
  return stableHash({ ...settings, summarizerModel: "" });
}

export function subjectPromptHash(): string {
  return createHash("sha256").update(SUBJECT_SYSTEM_PROMPT).digest("hex");
}

export function corpusHash(files: { path: string; bytes: string | Uint8Array }[]): string {
  return stableHash([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(f => [f.path, Buffer.from(f.bytes).toString("base64")]));
}
