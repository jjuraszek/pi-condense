import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
 *
 * Computed lazily on each read/write rather than frozen at module load, so the
 * resolved path always reflects the current `PI_CODING_AGENT_DIR` regardless of
 * when the module was first imported.
 */
export function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

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
    summarizerIdleTimeoutMs:
      typeof merged.summarizerIdleTimeoutMs === "number" &&
      Number.isFinite(merged.summarizerIdleTimeoutMs) &&
      merged.summarizerIdleTimeoutMs >= 0
        ? Math.floor(merged.summarizerIdleTimeoutMs)
        : DEFAULT_CONFIG.summarizerIdleTimeoutMs,
    summarizerMaxTimeoutMs:
      typeof merged.summarizerMaxTimeoutMs === "number" &&
      Number.isFinite(merged.summarizerMaxTimeoutMs) &&
      merged.summarizerMaxTimeoutMs >= 0
        ? Math.floor(merged.summarizerMaxTimeoutMs)
        : DEFAULT_CONFIG.summarizerMaxTimeoutMs,
    recoveryGraceTurns:
      typeof merged.recoveryGraceTurns === "number" &&
      Number.isFinite(merged.recoveryGraceTurns) &&
      merged.recoveryGraceTurns >= 0
        ? Math.floor(merged.recoveryGraceTurns)
        : DEFAULT_CONFIG.recoveryGraceTurns,
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
    spillThreshold:
      typeof merged.spillThreshold === "number" &&
      Number.isFinite(merged.spillThreshold) &&
      merged.spillThreshold > 0
        ? Math.floor(merged.spillThreshold)
        : DEFAULT_CONFIG.spillThreshold,
    spillPreviewBytes:
      typeof merged.spillPreviewBytes === "number" &&
      Number.isFinite(merged.spillPreviewBytes) &&
      merged.spillPreviewBytes >= 0
        ? Math.floor(merged.spillPreviewBytes)
        : DEFAULT_CONFIG.spillPreviewBytes,
    budgetTurnDelta:
      typeof merged.budgetTurnDelta === "number" &&
      Number.isFinite(merged.budgetTurnDelta) &&
      merged.budgetTurnDelta > 0 &&
      merged.budgetTurnDelta <= 1
        ? merged.budgetTurnDelta
        : DEFAULT_CONFIG.budgetTurnDelta,
    frontierGapThresholdTokens:
      typeof merged.frontierGapThresholdTokens === "number" &&
      Number.isFinite(merged.frontierGapThresholdTokens) &&
      merged.frontierGapThresholdTokens > 0
        ? Math.floor(merged.frontierGapThresholdTokens)
        : DEFAULT_CONFIG.frontierGapThresholdTokens,
    maxImagesPerRequest:
      typeof merged.maxImagesPerRequest === "number" &&
      Number.isFinite(merged.maxImagesPerRequest) &&
      merged.maxImagesPerRequest >= 1
        ? Math.floor(merged.maxImagesPerRequest)
        : DEFAULT_CONFIG.maxImagesPerRequest,
  };
}

export class SettingsReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`settings.json unreadable at ${path}: ${reason}`);
    this.name = "SettingsReadError";
  }
}

/**
 * Single classifier for settings.json read outcomes. Only ENOENT means "no
 * file"; every other failure throws so a save never starts from `{}` over a
 * file it could not read.
 */
async function readJsonObject(
  path: string,
  read: typeof readFile = readFile,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await read(path, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    throw new SettingsReadError(path, e.code ?? e.message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsReadError(path, "invalid JSON");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new SettingsReadError(path, "not a JSON object");
}

/**
 * Reads `<agent-dir>/settings.json` and returns the `contextPrune` block, or
 * defaults. Fail-soft: an unreadable or malformed file yields defaults, since
 * a broken settings.json is pi-wide and not this extension's to report.
 */
export async function loadConfig(): Promise<ContextPruneConfig> {
  let main: Record<string, unknown> | undefined;
  try {
    main = await readJsonObject(settingsPath());
  } catch (err) {
    if (err instanceof SettingsReadError) return { ...DEFAULT_CONFIG };
    throw err;
  }
  const namespaced = main?.[SETTINGS_KEY];
  if (namespaced && typeof namespaced === "object" && !Array.isArray(namespaced)) {
    return normalize(namespaced as Partial<ContextPruneConfig>);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Writes the full config back to `<agent-dir>/settings.json` under
 * {@link SETTINGS_KEY}, preserving every other top-level key in the file.
 * Tmp-file + atomic rename, so a concurrent reader never observes a partial
 * file. A file that cannot be read as a JSON object is never replaced: the
 * read throws {@link SettingsReadError} before anything is written. Concurrent
 * saves (ours or pi's own) are last-write-wins; that race is not coordinated.
 */
export async function saveConfig(config: ContextPruneConfig, read: typeof readFile = readFile): Promise<void> {
  const path = settingsPath();
  const current = (await readJsonObject(path, read)) ?? {};
  const next = { ...current, [SETTINGS_KEY]: config };
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmpPath, path);
}

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

/**
 * Saves and reports failure through `notify` instead of rejecting, so callers
 * can fire-and-forget. The in-memory change stands; only persistence failed.
 */
export async function persistConfig(
  notify: Notify,
  config: ContextPruneConfig,
  save: (config: ContextPruneConfig) => Promise<void> = saveConfig,
): Promise<void> {
  try {
    await save(config);
  } catch (err) {
    const reason = err instanceof SettingsReadError
      ? err.reason
      : ((err as NodeJS.ErrnoException | null | undefined)?.code ?? String(err));
    notify(`Could not save settings to ${settingsPath()}: ${reason}. Change applies to this session only.`, "error");
  }
}
