import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { seedEntries, type Scenario } from "./scenario";
import { IDLE_PIPELINE_SETTINGS, PIPELINE_SETTINGS, corpusHash, settingsHash } from "./config";
import { detectChains } from "../src/chain-detector";
import { isProtected } from "../src/protected";
import { idleCleanupDue } from "../src/idle-pause";

const directory = `${import.meta.dir}/scenarios-idle`;
const files = readdirSync(directory).filter(f => f.endsWith(".ts"));
const scenarios: Scenario[] = await Promise.all(files.map(async f => (await import(`${directory}/${f}`)).default));

test("skill twins share synthetic history and differ only in pause metadata", () => {
  const fresh = scenarios.find(s => s.id === "skill-gate-reply")!;
  const paused = scenarios.find(s => s.twinOf === fresh.id)!;
  expect(paused.history).toBe(fresh.history);
  expect(paused).toEqual({ ...fresh, id: "skill-gate-reply-paused", twinOf: fresh.id, seedAgeMinutes: 240 });
  expect(fresh.probe).toMatch(/^[A-Z]$/);
  expect(fresh.mechanical.contains).toHaveLength(1);
  expect(fresh.judged?.expected).toContain(fresh.mechanical.contains![0]);
});

test.each(scenarios)("$id reaches only the intended idle arm", s => {
  const now = Date.UTC(2026, 10, 17);
  const entries = seedEntries(s.history, now - (s.seedAgeMinutes ?? 0) * 60000);
  const branch = entries.filter(e => e.type !== "session");
  expect(idleCleanupDue({ branch, now, thresholdMinutes: IDLE_PIPELINE_SETTINGS.chainCompression.idleCleanupMinutes })).toBe(Boolean(s.twinOf));
  const chains = detectChains(branch.map(e => (e as any).message));
  expect(chains.length).toBeGreaterThan(0);
  expect(chains.length).toBeLessThanOrEqual(PIPELINE_SETTINGS.chainCompression.rollingWindow);
  for (const chain of chains) {
    expect(chain.finalAssistantTimestamp).not.toBeNull();
    const calls = s.history.flatMap(t => t.role === "assistant" ? t.toolCalls ?? [] : []);
    expect(calls.some(c => chain.middleToolCallIds.includes(c.id) && !isProtected(c.name, c.arguments, IDLE_PIPELINE_SETTINGS))).toBe(true);
  }
  expect(JSON.stringify(s)).not.toMatch(/\/Users\/|@|sk-|ghp_|https?:/);
  expect(s.mechanical.contains?.length).toBeGreaterThan(0);
  if (s.twinOf) {
    expect(scenarios.some(f => f.id === s.twinOf && !f.twinOf)).toBe(true);
    expect(s.seedAgeMinutes!).toBeGreaterThan(IDLE_PIPELINE_SETTINGS.chainCompression.idleCleanupMinutes);
  }
});

test("fresh seed clock preserves the seven-case comparison keys", async () => {
  expect(IDLE_PIPELINE_SETTINGS.protectedTools).toEqual([]);
  expect(IDLE_PIPELINE_SETTINGS).toEqual({ ...PIPELINE_SETTINGS, chainCompression: { ...PIPELINE_SETTINGS.chainCompression, idleCleanupMinutes: 180 } });
  const names = readdirSync(`${import.meta.dir}/scenarios`).filter(f => f.endsWith(".ts"));
  const corpus = corpusHash(names.map(path => ({ path, bytes: readFileSync(`${import.meta.dir}/scenarios/${path}`) })));
  const { readReport } = await import("./report");
  for (const name of readdirSync(`${import.meta.dir}/baseline`)) {
    const baseline = readReport(readFileSync(`${import.meta.dir}/baseline/${name}`, "utf8"));
    expect(baseline.key.corpusHash).toBe(corpus);
    expect(baseline.key.settingsHash).toBe(settingsHash());
  }
  const now = Date.UTC(2026, 10, 17);
  for (const name of names) {
    const scenario = (await import(`./scenarios/${name}`)).default;
    const entries = seedEntries(scenario.history, now);
    expect(Date.parse(entries.at(-1)!.timestamp)).toBe(now);
    expect(entries[0].timestamp).toBe(entries[1].timestamp);
    for (let i = 2; i < entries.length; i++) expect(Date.parse(entries[i].timestamp) - Date.parse(entries[i - 1].timestamp)).toBe(1000);
    expect(idleCleanupDue({ branch: entries.filter(e => e.type !== "session"), now, thresholdMinutes: 180 })).toBe(false);
  }
});
