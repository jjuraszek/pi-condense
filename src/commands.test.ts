import { describe, it, expect } from "bun:test";
import { pruneStatusText, setPruneStatusWidget } from "./commands.js";
import type { ContextPruneConfig } from "./types.js";

const cfg = (enabled: boolean): ContextPruneConfig => ({ enabled } as ContextPruneConfig);
const cfgVisible = (enabled: boolean): ContextPruneConfig =>
  ({ enabled, showPruneStatusLine: true } as ContextPruneConfig);

function captureStatus(config: ContextPruneConfig, value?: Parameters<typeof setPruneStatusWidget>[2]): string | undefined {
  let captured: string | undefined;
  setPruneStatusWidget({ ui: { setStatus: (_id, text) => { captured = text; } } }, config, value);
  return captured;
}

describe("pruneStatusText", () => {
  it("disabled config -> 'prune: OFF'", () => {
    expect(pruneStatusText(cfg(false))).toBe("prune: OFF");
  });

  it("enabled, no reclaim -> 'prune: ON'", () => {
    expect(pruneStatusText(cfg(true))).toBe("prune: ON");
  });

  it("enabled, undefined reclaim -> 'prune: ON'", () => {
    expect(pruneStatusText(cfg(true), undefined)).toBe("prune: ON");
  });

  it("enabled, beforeChars=0, afterChars=0 -> 'prune: ON' (guard divide-by-zero)", () => {
    expect(pruneStatusText(cfg(true), { beforeChars: 0, afterChars: 0 })).toBe("prune: ON");
  });

  it("enabled, {beforeChars:368000, afterChars:56000} -> ratio line", () => {
    // beforeTok=92000 -> "92.0k", afterTok=14000 -> "14.0k", reduction=85%
    expect(pruneStatusText(cfg(true), { beforeChars: 368000, afterChars: 56000 })).toBe(
      "prune: ON \u00b7 92.0k->14.0k (-85%)",
    );
  });

  it("enabled, no reduction (before==after) -> clamps to 0%", () => {
    // beforeTok=25, afterTok=25
    expect(pruneStatusText(cfg(true), { beforeChars: 100, afterChars: 100 })).toBe(
      "prune: ON \u00b7 25->25 (-0%)",
    );
  });

  it("enabled, expansion (afterChars > beforeChars) -> clamps to 0%", () => {
    expect(pruneStatusText(cfg(true), { beforeChars: 100, afterChars: 150 })).toMatch(/\(-0%\)$/);
  });
});

describe("setPruneStatusWidget", () => {
  it("wraps every rendered state in '\u2502 ... \u2502' for load-order-independent isolation", () => {
    expect(captureStatus(cfgVisible(false))).toBe("\u2502 prune: OFF \u2502");
    expect(captureStatus(cfgVisible(true))).toBe("\u2502 prune: ON \u2502");
    expect(captureStatus(cfgVisible(true), { beforeChars: 368000, afterChars: 56000 })).toBe(
      "\u2502 prune: ON \u00b7 92.0k->14.0k (-85%) \u2502",
    );
  });

  it("wraps string progress values too", () => {
    expect(captureStatus(cfgVisible(true), "prune: 3 pending")).toBe("\u2502 prune: 3 pending \u2502");
  });

  it("clears (no wrap) when the status line is hidden", () => {
    expect(captureStatus(cfg(true))).toBeUndefined();
  });
});
