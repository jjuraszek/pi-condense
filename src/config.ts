import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

/**
 * Settings location: the active pi agent's main `settings.json` under the
 * `contextPrune` namespace, mirroring pi's own conventions for `compaction`,
 * `retry`, `branchSummary`, etc. Pi's SettingsManager preserves unknown
 * top-level keys when it rewrites settings, so the namespace coexists safely
 * with pi's own settings.
 *
 * Resolved against `getAgentDir()` so it honors `PI_CODING_AGENT_DIR`
 * (defaults to `~/.pi/agent`). Each pi preset directory therefore gets its
 * own context-prune config — including its own summarizer model.
 */
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/** Top-level key under which context-prune state lives in `settings.json`. */
export const SETTINGS_KEY = "contextPrune" as const;

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

function normalize(existing: Partial<ContextPruneConfig>): ContextPruneConfig {
  const merged = { ...DEFAULT_CONFIG, ...existing };
  return {
    ...merged,
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
    showPruneStatusLine:
      typeof merged.showPruneStatusLine === "boolean"
        ? merged.showPruneStatusLine
        : DEFAULT_CONFIG.showPruneStatusLine,
    pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
    summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
      ? merged.summarizerThinking
      : DEFAULT_CONFIG.summarizerThinking,
    remindUnprunedCount:
      typeof merged.remindUnprunedCount === "boolean"
        ? merged.remindUnprunedCount
        : DEFAULT_CONFIG.remindUnprunedCount,
    quietOversizedSkips:
      typeof merged.quietOversizedSkips === "boolean"
        ? merged.quietOversizedSkips
        : DEFAULT_CONFIG.quietOversizedSkips,
    minBatchChars:
      typeof merged.minBatchChars === "number" &&
      Number.isFinite(merged.minBatchChars) &&
      merged.minBatchChars >= 0
        ? Math.floor(merged.minBatchChars)
        : DEFAULT_CONFIG.minBatchChars,
    dedupByContentHash:
      typeof merged.dedupByContentHash === "boolean"
        ? merged.dedupByContentHash
        : DEFAULT_CONFIG.dedupByContentHash,
    autoBudgetThreshold:
      typeof merged.autoBudgetThreshold === "number" &&
      Number.isFinite(merged.autoBudgetThreshold) &&
      merged.autoBudgetThreshold > 0 &&
      merged.autoBudgetThreshold <= 1
        ? merged.autoBudgetThreshold
        : DEFAULT_CONFIG.autoBudgetThreshold,
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Reads `<agent-dir>/settings.json` and returns the `contextPrune` block, or defaults. */
export async function loadConfig(): Promise<ContextPruneConfig> {
  const main = await readJsonObject(SETTINGS_PATH);
  const namespaced = main?.[SETTINGS_KEY];
  if (namespaced && typeof namespaced === "object" && !Array.isArray(namespaced)) {
    return normalize(namespaced as Partial<ContextPruneConfig>);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Writes the full config back to `<agent-dir>/settings.json` under
 * {@link SETTINGS_KEY}, preserving every other top-level key in the file. Uses
 * a tmp-file + atomic rename so concurrent pi writes (e.g. theme changes via
 * `/settings`) cannot observe a partial file. We do not coordinate with pi's
 * own internal lock since both writers do whole-file replacements and a
 * last-write-wins race only loses a single change, never corrupts the file.
 */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  const current = (await readJsonObject(SETTINGS_PATH)) ?? {};
  const next = { ...current, [SETTINGS_KEY]: config };
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  const tmpPath = `${SETTINGS_PATH}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmpPath, SETTINGS_PATH);
}
