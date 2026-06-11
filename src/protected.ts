/** Structural pick of ContextPruneConfig — keeps this module dependency-free. */
export interface ProtectionConfig {
  protectedTools: readonly string[];
  protectedPaths: readonly string[];
}

// Compile-once: pattern -> RegExp is pure, so the cache never needs
// invalidation. Patterns only come from config arrays, so growth is bounded.
const patternCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]*/)*"; // `**/` — zero or more whole directories
          i += 3;
        } else {
          re += ".*"; // bare `**`
          i += 2;
        }
      } else {
        re += "[^/]*"; // `*` — segment-local
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  patternCache.set(pattern, compiled);
  return compiled;
}

export function isProtected(toolName: string, args: unknown, config: ProtectionConfig): boolean {
  if (config.protectedTools.includes(toolName)) return true;
  if (config.protectedPaths.length === 0) return false;
  const path = (args as Record<string, unknown> | null | undefined)?.path;
  if (typeof path !== "string") return false;
  const normalized = path.replace(/\\/g, "/");
  return config.protectedPaths.some((p) => globToRegExp(p).test(normalized));
}
