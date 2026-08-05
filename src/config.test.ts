import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * config.ts resolves the settings path from getAgentDir() lazily on each
 * read/write, so PI_CODING_AGENT_DIR set here is honored regardless of import
 * order (bun shares the module registry across test files). normalize() itself
 * isn't exported; loadConfig() is the only public entry point that exercises
 * it, so these tests drive normalization indirectly by writing settings.json
 * into an isolated agent dir and reading it back.
 */
let tmpDir: string;
let loadConfig: typeof import("./config.js").loadConfig;
let saveConfig: typeof import("./config.js").saveConfig;
let settingsPath: typeof import("./config.js").settingsPath;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pi-condense-config-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  const mod = await import("./config.js");
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
  settingsPath = mod.settingsPath;
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeContextPrune(overrides: Record<string, unknown>): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify({ contextPrune: overrides }));
}

describe("loadConfig recoveryGraceTurns normalization", () => {
  it("preserves an explicit 0", async () => {
    await writeContextPrune({ recoveryGraceTurns: 0 });
    const config = await loadConfig();
    expect(config.recoveryGraceTurns).toBe(0);
  });

  it("falls back to the default for a negative value", async () => {
    await writeContextPrune({ recoveryGraceTurns: -1 });
    const config = await loadConfig();
    expect(config.recoveryGraceTurns).toBe(DEFAULT_CONFIG.recoveryGraceTurns);
  });

  it("falls back to the default for NaN", async () => {
    await writeContextPrune({ recoveryGraceTurns: Number.NaN });
    const config = await loadConfig();
    expect(config.recoveryGraceTurns).toBe(DEFAULT_CONFIG.recoveryGraceTurns);
  });

  it("floors a fractional value", async () => {
    await writeContextPrune({ recoveryGraceTurns: 2.7 });
    const config = await loadConfig();
    expect(config.recoveryGraceTurns).toBe(2);
  });

  it("falls back to the default when unset", async () => {
    await writeContextPrune({});
    const config = await loadConfig();
    expect(config.recoveryGraceTurns).toBe(DEFAULT_CONFIG.recoveryGraceTurns);
  });
});

describe("loadConfig summarizer timeout normalization", () => {
  it("defaults both timeouts when absent", async () => {
    await writeContextPrune({});
    const config = await loadConfig();
    expect(config.summarizerIdleTimeoutMs).toBe(DEFAULT_CONFIG.summarizerIdleTimeoutMs);
    expect(config.summarizerMaxTimeoutMs).toBe(DEFAULT_CONFIG.summarizerMaxTimeoutMs);
  });

  it("preserves explicit 0 (disabled) for both", async () => {
    await writeContextPrune({ summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 0 });
    const config = await loadConfig();
    expect(config.summarizerIdleTimeoutMs).toBe(0);
    expect(config.summarizerMaxTimeoutMs).toBe(0);
  });

  it("falls back to default for a negative idle timeout", async () => {
    await writeContextPrune({ summarizerIdleTimeoutMs: -5 });
    const config = await loadConfig();
    expect(config.summarizerIdleTimeoutMs).toBe(DEFAULT_CONFIG.summarizerIdleTimeoutMs);
  });

  it("falls back to default for NaN max timeout", async () => {
    // JSON.stringify serializes NaN to null; normalize's typeof-number guard rejects it.
    await writeContextPrune({ summarizerMaxTimeoutMs: Number.NaN });
    const config = await loadConfig();
    expect(config.summarizerMaxTimeoutMs).toBe(DEFAULT_CONFIG.summarizerMaxTimeoutMs);
  });

  it("floors a fractional idle timeout", async () => {
    await writeContextPrune({ summarizerIdleTimeoutMs: 1234.9 });
    const config = await loadConfig();
    expect(config.summarizerIdleTimeoutMs).toBe(1234);
  });
});

describe("loadConfig backward compatibility with removed thinkingStrip key", () => {
  it("loads without error and round-trips a stale contextPrune.thinkingStrip block unchanged", async () => {
    const stale = { enabled: true, keepLastTurns: 16 };
    await writeContextPrune({ thinkingStrip: stale });

    const config = await loadConfig();

    // thinkingStrip is no longer a recognized key: DEFAULT_CONFIG carries no
    // such field, so nothing reads or acts on it.
    expect((DEFAULT_CONFIG as unknown as Record<string, unknown>).thinkingStrip).toBeUndefined();
    // normalize() spreads { ...DEFAULT_CONFIG, ...existing } and re-spreads
    // the merge, so the unrecognized key survives verbatim on the loaded value.
    expect((config as unknown as Record<string, unknown>).thinkingStrip).toEqual(stale);

    // saveConfig() re-serializes the same config object it's given, so the
    // stale block written above must still be present, byte-equivalent, after
    // a full load -> save round trip through the real settingsPath() file.
    await saveConfig(config);
    const raw = await readFile(settingsPath(), "utf-8");
    const written = JSON.parse(raw);
    expect(written.contextPrune.thinkingStrip).toEqual(stale);
  });
});
