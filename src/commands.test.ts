import { describe, it, expect, mock } from "bun:test";
import { pruneStatusText, setPruneStatusWidget, registerCommands } from "./commands.js";
import type { ContextPruneConfig, ContextMetricsSnapshot, SummarizerStats } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const cfg = (enabled: boolean): ContextPruneConfig => ({ enabled } as ContextPruneConfig);
const cfgVisible = (enabled: boolean): ContextPruneConfig =>
  ({ enabled, showPruneStatusLine: true } as ContextPruneConfig);

function captureStatus(
  config: ContextPruneConfig,
  value?: Parameters<typeof setPruneStatusWidget>[2],
  diagnostics?: Parameters<typeof setPruneStatusWidget>[3],
  metrics?: Parameters<typeof setPruneStatusWidget>[4],
): string | undefined {
  let captured: string | undefined;
  setPruneStatusWidget({ ui: { setStatus: (_id, text) => { captured = text; } } }, config, value, diagnostics, metrics);
  return captured;
}

// ── /pruner command handler harness (registerCommands) ──────────────────────
// Drives the real switch-statement handler registered by registerCommands,
// with all injected collaborators stubbed. This is the seam for exercising
// /pruner subcommands without booting the full index.ts extension.
function setupPrunerCommand(overrides: {
  capturePendingBatches?: () => any[];
  flushPending?: (ctx: any, options?: any) => Promise<any>;
  getRearmed?: () => boolean;
  getContextMetrics?: (ctx: any) => ContextMetricsSnapshot;
} = {}) {
  let handler: (args: string, ctx: any) => Promise<void>;
  const notifications: { message: string; type?: string }[] = [];
  const flushCalls: any[] = [];

  const flushPending =
    overrides.flushPending ??
    (async (_ctx: any, options?: any) => {
      flushCalls.push(options);
      return { ok: false, reason: "empty" };
    });

  const pi: any = {
    registerCommand(_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
      handler = spec.handler;
    },
    registerMessageRenderer() {},
  };

  const currentConfig = { value: { ...DEFAULT_CONFIG, enabled: true } };

  registerCommands(
    pi,
    currentConfig,
    flushPending,
    overrides.capturePendingBatches ?? (() => []),
    () => ({ callCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 } as SummarizerStats),
    () => undefined,
    {} as any,
    async () => ({ compressedEntries: [], skipped: 0 }),
    undefined,
    overrides.getContextMetrics,
    undefined,
    overrides.getRearmed,
  );

  const ctx: any = {
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  return {
    run: (args: string) => handler(args, ctx),
    notifications,
    flushCalls,
  };
}

describe("/pruner now (empty capture)", () => {
  it("invokes flushPending even when nothing is pending, so a flush-metrics entry is recorded", async () => {
    const harness = setupPrunerCommand({ capturePendingBatches: () => [] });
    await harness.run("now");

    expect(harness.flushCalls.length).toBe(1);
    expect(harness.flushCalls[0]).toMatchObject({ previewedBatches: [], trigger: "manual" });
    expect(harness.notifications[0]?.message).toBe("pruner: nothing pending — no batches to summarize");
  });
});

describe("/pruner status context block", () => {
  const metrics: ContextMetricsSnapshot = {
    openCycleThinkingTokens: 12000,
    largestChainSharePct: 62,
    frontierGapTokens: 195000,
  };

  it("renders the --- context --- block with all three metrics", async () => {
    const harness = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => false });
    await harness.run("status");

    const text = harness.notifications[0]?.message ?? "";
    expect(text).toContain("--- context ---");
    expect(text).toContain("thinking:     12.0k tokens (open segment)");
    expect(text).toContain("chain share:  62%");
    expect(text).toContain("frontier gap: 195.0k tokens");
  });

  it("appends the rearmed: line only when getRearmed() is true", async () => {
    const armed = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => true });
    await armed.run("status");
    expect(armed.notifications[0]?.message).toContain("rearmed:      yes");

    const notArmed = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => false });
    await notArmed.run("status");
    expect(notArmed.notifications[0]?.message).not.toContain("rearmed:");
  });

  it("omits the context block entirely when getContextMetrics is unwired", async () => {
    const harness = setupPrunerCommand();
    await harness.run("status");
    expect(harness.notifications[0]?.message).not.toContain("--- context ---");
  });
});

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
  it("prefixes every rendered state with a single leading '\u2502' for load-order-independent isolation", () => {
    expect(captureStatus(cfgVisible(false))).toBe("\u2502 prune: OFF");
    expect(captureStatus(cfgVisible(true))).toBe("\u2502 prune: ON");
    expect(captureStatus(cfgVisible(true), { beforeChars: 368000, afterChars: 56000 })).toBe(
      "\u2502 prune: ON \u00b7 92.0k->14.0k (-85%)",
    );
  });

  it("prefixes string progress values too", () => {
    expect(captureStatus(cfgVisible(true), "prune: 3 pending")).toBe("\u2502 prune: 3 pending");
  });

  it("clears (no wrap) when the status line is hidden", () => {
    expect(captureStatus(cfg(true))).toBeUndefined();
  });
});

describe("diagnostic counters on the status line", () => {
  const zeroDiag = { "unresolved-range": 0, "range-id-mismatch": 0, "orphan-sweep": 0 } as const;
  const mixedDiag = { "unresolved-range": 2, "range-id-mismatch": 0, "orphan-sweep": 1 } as const;

  it("omits the diagnostic segment when all counters are zero", () => {
    expect(pruneStatusText(cfg(true), undefined, zeroDiag)).toBe("prune: ON");
  });

  it("appends a compact segment when a counter fires, omitting zero kinds", () => {
    const text = pruneStatusText(cfg(true), undefined, mixedDiag);
    expect(text).toBe("prune: ON \u00b7 diag u2/o1");
  });

  it("appends the diagnostic segment to the reclaim form too", () => {
    const text = pruneStatusText(cfg(true), { beforeChars: 368000, afterChars: 56000 }, mixedDiag);
    expect(text).toBe("prune: ON \u00b7 92.0k->14.0k (-85%) \u00b7 diag u2/o1");
  });

  it("setPruneStatusWidget forwards the counters", () => {
    expect(captureStatus(cfgVisible(true), undefined, { "unresolved-range": 1, "range-id-mismatch": 0, "orphan-sweep": 0 })).toBe(
      "\u2502 prune: ON \u00b7 diag u1",
    );
  });

  it("appends b<N> for backfill-empty alongside u/m/o", () => {
    const text = pruneStatusText(cfg(true), undefined, {
      "unresolved-range": 2,
      "range-id-mismatch": 0,
      "orphan-sweep": 1,
      "backfill-empty": 2,
    });
    expect(text).toBe("prune: ON \u00b7 diag u2/o1/b2");
  });
});

describe("context metrics suffix on the status line", () => {
  const metrics: ContextMetricsSnapshot = {
    openCycleThinkingTokens: 12000,
    largestChainSharePct: 62,
    frontierGapTokens: 195000,
  };

  it("appends a compact think/gap/chain segment when frontierGapTokens > 0", () => {
    const text = pruneStatusText(cfg(true), undefined, undefined, metrics);
    expect(text).toContain("\u00b7 think 12.0k \u00b7 gap 195.0k \u00b7 chain 62%");
  });

  it("omits the suffix when frontierGapTokens is 0", () => {
    const withZeroGap = { ...metrics, frontierGapTokens: 0 };
    expect(pruneStatusText(cfg(true), undefined, undefined, withZeroGap)).toBe(
      pruneStatusText(cfg(true)),
    );
  });

  it("composes after the diag suffix when both are present", () => {
    const mixedDiag = { "unresolved-range": 2, "range-id-mismatch": 0, "orphan-sweep": 1 } as const;
    const text = pruneStatusText(cfg(true), undefined, mixedDiag, metrics);
    expect(text).toBe("prune: ON \u00b7 diag u2/o1 \u00b7 think 12.0k \u00b7 gap 195.0k \u00b7 chain 62%");
  });
});
