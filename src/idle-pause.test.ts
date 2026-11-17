import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { idleCleanupDue, lastCacheRefreshMs } from "./idle-pause.js";
import { DEFAULT_CONFIG } from "./types.js";

const now = Date.UTC(2026, 10, 17, 12);
const minute = 60_000;
const thresholdMinutes = DEFAULT_CONFIG.chainCompression.idleCleanupMinutes;
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function refresh(kind: "assistant" | "cache_warm", ageMinutes: number, messageAgeMinutes = ageMinutes): SessionEntry {
  const timestamp = new Date(now - ageMinutes * minute).toISOString();
  const base = { id: `${kind}-${ageMinutes}`, parentId: null, timestamp };
  return kind === "cache_warm"
    ? { ...base, type: "usage", kind, provider: "fixture", model: "fixture", usage }
    : {
      ...base, type: "message",
      message: {
        role: "assistant", content: [{ type: "text", text: "Finished." }], timestamp: now - messageAgeMinutes * minute,
        api: "anthropic-messages", provider: "fixture", model: "fixture", usage, stopReason: "stop",
      },
    };
}

const ignored: SessionEntry[] = [
  { type: "message", id: "prompt", parentId: null, timestamp: new Date(now).toISOString(),
    message: { role: "user", content: "Continue.", timestamp: now } },
  { type: "usage", id: "other-usage", parentId: null, timestamp: new Date(now).toISOString(),
    kind: "other", provider: "fixture", model: "fixture", usage },
  { type: "custom", id: "summary", parentId: null, timestamp: new Date(now).toISOString(), customType: "context-prune-summary" },
];

describe("idle pause clock", () => {
  it.each([
    { assistantAge: 240, warmAge: 60, newestAge: 60 },
    { assistantAge: 30, warmAge: 60, newestAge: 30 },
    { assistantAge: 60, warmAge: 60, newestAge: 60 },
  ])("takes the newest of assistant and cache-warm timestamps (%j)", ({ assistantAge, warmAge, newestAge }) => {
    const branch = [refresh("assistant", assistantAge), refresh("cache_warm", warmAge), ...ignored];
    expect(lastCacheRefreshMs(branch)).toBe(now - newestAge * minute);
    expect(lastCacheRefreshMs(branch.toReversed())).toBe(now - newestAge * minute);
    expect(idleCleanupDue({ branch, now, thresholdMinutes })).toBe(false);
  });

  it.each([
    { entryAge: 60, messageAge: 300, due: false },
    { entryAge: 300, messageAge: 60, due: true },
  ])("reads the entry timestamp for both kinds (%j)", ({ entryAge, messageAge, due }) => {
    for (const kind of ["assistant", "cache_warm"] as const) {
      const branch = [refresh(kind, entryAge, messageAge)];
      expect(lastCacheRefreshMs(branch)).toBe(now - entryAge * minute);
      expect(idleCleanupDue({ branch, now, thresholdMinutes })).toBe(due);
    }
  });

  it.each(["error", "aborted"] as const)("counts an assistant request ending in %s", (stopReason) => {
    const entry = refresh("assistant", 60);
    if (entry.type === "message" && entry.message.role === "assistant") entry.message.stopReason = stopReason;
    expect(lastCacheRefreshMs([refresh("cache_warm", 240), entry])).toBe(now - 60 * minute);
    expect(idleCleanupDue({ branch: [entry], now, thresholdMinutes })).toBe(false);
  });

  it.each(["assistant", "cache_warm"] as const)("expires strictly after the threshold for %s", (kind) => {
    const branch = [refresh(kind, thresholdMinutes)];
    expect(idleCleanupDue({ branch, now: now - 1, thresholdMinutes })).toBe(false);
    expect(idleCleanupDue({ branch, now, thresholdMinutes })).toBe(false);
    expect(idleCleanupDue({ branch, now: now + 1, thresholdMinutes })).toBe(true);
  });

  it.each([{ branch: [] }, { branch: ignored }])("does not invent a refresh time (%j)", ({ branch }) => {
    expect(lastCacheRefreshMs(branch)).toBeUndefined();
    expect(idleCleanupDue({ branch, now, thresholdMinutes })).toBe(false);
  });

  it.each([
    { threshold: 180, lifetime: 1440 },
    { threshold: 180, lifetime: 30 },
    { threshold: 180, lifetime: 180 },
    { threshold: 1, lifetime: 5 },
    { threshold: 1, lifetime: 60 },
  ])("uses the longer of the declared lifetime and threshold (%j)", ({ threshold, lifetime }) => {
    const branch = [refresh("assistant", 0)];
    const effective = Math.max(threshold, lifetime) * minute;
    const options = { branch, thresholdMinutes: threshold, declaredLifetimeMs: lifetime * minute };
    expect(idleCleanupDue({ ...options, now: now + effective - 1 })).toBe(false);
    expect(idleCleanupDue({ ...options, now: now + effective })).toBe(false);
    expect(idleCleanupDue({ ...options, now: now + effective + 1 })).toBe(true);
  });

  it("does not clean when the newest refresh is in the future", () => {
    const branch = [refresh("assistant", 300), refresh("cache_warm", -1)];
    expect(lastCacheRefreshMs(branch)).toBe(now + minute);
    expect(idleCleanupDue({ branch, now, thresholdMinutes })).toBe(false);
  });
});
