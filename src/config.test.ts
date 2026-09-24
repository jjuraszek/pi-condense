import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./types.js";
import type { ContextPruneConfig } from "./types.js";

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
let persistConfig: typeof import("./config.js").persistConfig;
let SettingsReadError: typeof import("./config.js").SettingsReadError;
let settingsPath: typeof import("./config.js").settingsPath;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pi-condense-config-test-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  const mod = await import("./config.js");
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
  persistConfig = mod.persistConfig;
  SettingsReadError = mod.SettingsReadError;
  settingsPath = mod.settingsPath;
});

// Every case below may leave a malformed settings.json behind; remove it so
// the shared path is clean for the next case.
afterEach(async () => {
  await rm(settingsPath(), { force: true });
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeContextPrune(overrides: Record<string, unknown>): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify({ contextPrune: overrides }));
}

describe("loadConfig protectedPaths", () => {
  it("uses the defaults when unset", async () => {
    await writeContextPrune({});
    const config = await loadConfig();
    expect(config.protectedPaths).toEqual(DEFAULT_CONFIG.protectedPaths);
  });

  it("replaces defaults with user-supplied paths, including an empty list", async () => {
    for (const protectedPaths of [["**/custom.md"], []]) {
      await writeContextPrune({ protectedPaths });
      const config = await loadConfig();
      expect(config.protectedPaths).toEqual(protectedPaths);
    }
  });
});

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

describe("loadConfig frontierGapThresholdTokens normalization", () => {
  it("defaults to null when unset", async () => {
    await writeContextPrune({});
    const config = await loadConfig();
    expect(config.frontierGapThresholdTokens).toBeNull();
  });

  it("floors a fractional value", async () => {
    await writeContextPrune({ frontierGapThresholdTokens: 80000.7 });
    const config = await loadConfig();
    expect(config.frontierGapThresholdTokens).toBe(80000);
  });

  it("falls back to null for 0, negative, Infinity, or a string", async () => {
    for (const value of [0, -5, Infinity, "80000"]) {
      await writeContextPrune({ frontierGapThresholdTokens: value });
      const config = await loadConfig();
      expect(config.frontierGapThresholdTokens).toBeNull();
    }
  });
});

describe("loadConfig maxImagesPerRequest normalization", () => {
  it("defaults to null when unset", async () => {
    await writeContextPrune({});
    const config = await loadConfig();
    expect(config.maxImagesPerRequest).toBeNull();
  });

  it("floors a fractional value", async () => {
    await writeContextPrune({ maxImagesPerRequest: 20.9 });
    const config = await loadConfig();
    expect(config.maxImagesPerRequest).toBe(20);
  });

  it("falls back to null for 0, a value below 1, negative, Infinity, or a string", async () => {
    for (const value of [0, 0.5, -3, Infinity, "20"]) {
      await writeContextPrune({ maxImagesPerRequest: value });
      const config = await loadConfig();
      expect(config.maxImagesPerRequest).toBeNull();
    }
  });
});

describe("saveConfig fails closed (#15)", () => {
  const config: ContextPruneConfig = { ...DEFAULT_CONFIG, enabled: false };

  it("creates settings.json containing only contextPrune when the file is absent", async () => {
    await rm(settingsPath(), { force: true });
    await saveConfig(config);
    const written = JSON.parse(await readFile(settingsPath(), "utf-8"));
    expect(Object.keys(written)).toEqual(["contextPrune"]);
    expect(written.contextPrune.enabled).toBe(false);
  });

  it("preserves other top-level keys and replaces contextPrune", async () => {
    await writeFile(settingsPath(), '{"foo":1,"contextPrune":{"enabled":true}}');
    await saveConfig(config);
    const written = JSON.parse(await readFile(settingsPath(), "utf-8"));
    expect(written.foo).toBe(1);
    expect(written.contextPrune.enabled).toBe(false);
  });

  for (const [label, raw] of [
    ["0-byte file", ""],
    ["truncated JSON", '{"foo":'],
    ["array", "[]"],
    ["null", "null"],
    ["string", '"str"'],
    ["number", "42"],
  ] as const) {
    it(`rejects and leaves the file byte-identical for ${label}; loadConfig returns defaults`, async () => {
      await writeFile(settingsPath(), raw);
      const before = readFileSync(settingsPath());
      await expect(saveConfig(config)).rejects.toBeInstanceOf(SettingsReadError);
      expect(readFileSync(settingsPath()).equals(before)).toBe(true);
      expect(await loadConfig()).toEqual({ ...DEFAULT_CONFIG });
    });
  }

  it("rejects with reason EACCES when the injected read fails, leaving the file byte-identical", async () => {
    await writeFile(settingsPath(), '{"foo":1}');
    const before = readFileSync(settingsPath());
    const read = (async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }) as unknown as typeof import("node:fs/promises").readFile;
    const err = await saveConfig(config, read).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsReadError);
    expect(err.reason).toBe("EACCES");
    expect(err.path).toBe(settingsPath());
    expect(readFileSync(settingsPath()).equals(before)).toBe(true);
  });
});

describe("persistConfig (#15)", () => {
  const config: ContextPruneConfig = { ...DEFAULT_CONFIG, enabled: false };

  it("notifies once with type error and the settings path when the file is truncated", async () => {
    await writeFile(settingsPath(), '{"foo":');
    const calls: { message: string; type?: string }[] = [];
    await persistConfig((message, type) => calls.push({ message, type }), config);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("error");
    expect(calls[0].message).toContain(settingsPath());
    expect(calls[0].message).toContain("invalid JSON");
    expect(calls[0].message).toContain("Change applies to this session only.");
  });

  it("does not notify when the file is missing", async () => {
    await rm(settingsPath(), { force: true });
    const calls: unknown[] = [];
    await persistConfig((message, type) => calls.push({ message, type }), config);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(await readFile(settingsPath(), "utf-8")).contextPrune.enabled).toBe(false);
  });

  it("handles a save that rejects with undefined", async () => {
    const calls: { message: string; type?: string }[] = [];
    await persistConfig(
      (message, type) => calls.push({ message, type }),
      config,
      () => Promise.reject(undefined),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("error");
    expect(calls[0].message).toContain(settingsPath());
    expect(calls[0].message).toContain("undefined");
  });
});
