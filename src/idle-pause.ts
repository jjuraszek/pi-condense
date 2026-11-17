import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function lastCacheRefreshMs(branch: SessionEntry[]): number | undefined {
  let newest = -Infinity;
  for (const entry of branch) {
    if ((entry.type === "message" && entry.message.role === "assistant") ||
        (entry.type === "usage" && entry.kind === "cache_warm")) {
      const timestamp = Date.parse(entry.timestamp);
      if (timestamp > newest) newest = timestamp;
    }
  }
  return newest === -Infinity ? undefined : newest;
}

export function idleCleanupDue({ branch, now, thresholdMinutes, declaredLifetimeMs }: {
  branch: SessionEntry[];
  now: number;
  thresholdMinutes: number;
  declaredLifetimeMs?: number;
}): boolean {
  const last = lastCacheRefreshMs(branch);
  return last !== undefined && now - last > Math.max(thresholdMinutes * 60_000, declaredLifetimeMs ?? 0);
}
