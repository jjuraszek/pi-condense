import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * config.ts computes SETTINGS_PATH from getAgentDir() at module-load time, so
 * PI_CODING_AGENT_DIR must be set before the module is imported. normalize()
 * itself isn't exported; loadConfig() is the only public entry point that
 * exercises it, so these tests drive normalization indirectly by writing
 * settings.json into an isolated agent dir and reading it back.
 */
let tmpDir: string;
let loadConfig: typeof import("./config.js").loadConfig;
let SETTINGS_PATH: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pi-condense-config-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  const mod = await import("./config.js");
  loadConfig = mod.loadConfig;
  SETTINGS_PATH = mod.SETTINGS_PATH;
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeContextPrune(overrides: Record<string, unknown>): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify({ contextPrune: overrides }));
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
