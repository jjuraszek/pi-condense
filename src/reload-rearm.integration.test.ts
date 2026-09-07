import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualCompat from "@earendil-works/pi-ai/compat";
import { supersededStub } from "./supersede.js";

// This must run before any module that transitively reads PI_CODING_AGENT_DIR
// (src/config.ts's getAgentDir()) is imported/executed.
const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-condense-rearm-"));
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
writeFileSync(
  join(tmpAgentDir, "settings.json"),
  JSON.stringify({
    contextPrune: {
      enabled: true,
      pruneOn: "agent-message",
      batchingMode: "agent-message",
      autoBudgetThreshold: 0.5,
      summarizerModel: "default",
      minBatchChars: 1,
      showPruneStatusLine: true,
      chainCompression: {
        enabled: false,
        rollingWindow: 3,
        stripFinalAssistantThinking: true,
        fuseRangeSummary: true,
      },
    },
  }),
);

let summarizerCalls = 0;

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function okStream() {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text: "[[1:read]] summary" }], usage: USAGE };
    },
  };
}

// Classified "transient" by runOnce (src/summarizer.ts) — with
// summarizerModel: "default" (no distinct fallback model) this yields a
// null SummarizeResult after exactly one stream() call, no retries.
function errStream(message: string) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "error", errorMessage: message, content: [], usage: USAGE };
    },
  };
}

let streamImpl: (model: any, input?: any, opts?: any) => any = () => {
  summarizerCalls++;
  return okStream();
};

mock.module("@earendil-works/pi-ai/compat", () => ({
  ...actualCompat,
  stream: (...args: any[]) => streamImpl(...args),
}));

type AppendedEntry = { type: string; data: unknown };

// The captured-but-unflushed batch: a user message, an assistant message with
// one open toolCall (no closing text-only assistant — chain stays open), and
// its toolResult. This is what a reload's branch rescan must pick up
// (src/batch-capture.ts captureUnindexedBatchesFromSession).
function defaultBranch(): any[] {
  return [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "read the file" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(400) }],
        timestamp: Date.now(),
      },
    },
  ];
}

// Builds `count` independent closed chains (each: user -> assistant toolCall
// -> toolResult -> final text-only assistant), one per user turn, so each
// becomes its own captured batch under batchingMode "agent-message" and the
// chain detector (src/chain-detector.ts) sees `count` closed candidates.
// Used by the chain-compression-failure scenario below, which needs enough
// closed chains to clear the rolling window (hardcoded to 3 in this file's
// settings fixtures) and make at least one chain actually eligible for
// compression (src/chain-compressor.ts selectEligible).
function closedChainBranch(count: number): any[] {
  const msgs: any[] = [];
  let t = Date.now();
  for (let i = 0; i < count; i++) {
    t += 1000;
    msgs.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `do task ${i}` }], timestamp: t } });
    msgs.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: {} }] },
    });
    t += 1000;
    msgs.push({
      type: "message",
      message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], timestamp: t },
    });
    t += 1000;
    msgs.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `done ${i}` }], timestamp: t } });
  }
  return msgs;
}

// Builds one independent pending batch: user -> assistant toolCall -> toolResult,
// with no closing text-only assistant (chain stays open, matching defaultBranch's
// shape). Used by the frontier-gap tests below to grow/shrink the branch's
// un-pruned tail across turns by direct array mutation (bootExtension returns
// the live `branch` array reference, so pushing onto it after boot is visible
// to every later getBranch() call).
function pendingBatchEntries(toolCallId: string, text: string, timestamp: number): any[] {
  return [
    { type: "message", message: { role: "user", content: [{ type: "text", text: `do ${toolCallId}` }], timestamp } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }], timestamp: timestamp + 500 },
    },
    {
      type: "message",
      message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], timestamp: timestamp + 1000 },
    },
  ];
}

// Boots a fresh index.ts extension instance against an isolated agent dir +
// session, mirroring the fixtures shared across the three scenarios below.
//
// By default pi.appendEntry and ctx.sessionManager.appendCustomEntry push
// into the SAME `appended` array (matching flushPending's actual behavior:
// most delivery="session" writes go through sessionManager, with pi.appendEntry
// only used as the emit-time fallback for empty/aborted/pre-capture-failure
// exits) — so `appended` is the single chronological log the first two
// scenarios assert against.
//
// `separatePiAppended: true` (stale-runtime scenario) gives pi.appendEntry
// its own array so a test can assert an entry never reached it, independent
// of what landed in `sessionAppended`.
//
// `sessionAppendCustomEntry`/`piAppendEntry` wrap the underlying push (still
// targeting the same array) so a scenario can inject a throw for a specific
// customType without duplicating the harness.
function bootExtension(
  options: {
    chainCompressionEnabled?: boolean;
    rollingWindow?: number;
    separatePiAppended?: boolean;
    piAppendEntry?: (push: (type: string, data?: unknown) => void) => (type: string, data?: unknown) => void;
    sessionAppendCustomEntry?: (push: (type: string, data?: unknown) => void) => (type: string, data?: unknown) => string;
    branch?: any[];
    protectedTools?: string[];
    protectedPaths?: string[];
    autoBudgetThreshold?: number | null;
    budgetTurnDelta?: number | null;
    frontierGapThresholdTokens?: number | null;
  } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-rearm-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const contextPruneSettings: any = {
    enabled: true,
    pruneOn: "agent-message",
    batchingMode: "agent-message",
    autoBudgetThreshold: options.autoBudgetThreshold === undefined ? 0.5 : options.autoBudgetThreshold,
    summarizerModel: "default",
    minBatchChars: 1,
    showPruneStatusLine: true,
    protectedTools: options.protectedTools ?? [],
    chainCompression: {
      enabled: options.chainCompressionEnabled ?? false,
      rollingWindow: options.rollingWindow ?? 3,
      stripFinalAssistantThinking: true,
      fuseRangeSummary: true,
    },
  };
  // Omitted unless the test explicitly passes them, so the "default-null
  // inert" scenario can assert behavior with no key present at all (not an
  // explicit null), matching config.ts's own default.
  if (options.protectedPaths !== undefined) contextPruneSettings.protectedPaths = options.protectedPaths;
  if (options.budgetTurnDelta !== undefined) contextPruneSettings.budgetTurnDelta = options.budgetTurnDelta;
  if (options.frontierGapThresholdTokens !== undefined) {
    contextPruneSettings.frontierGapThresholdTokens = options.frontierGapThresholdTokens;
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ contextPrune: contextPruneSettings }),
  );

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-condense-rearm-session-"));
  const appended: AppendedEntry[] = [];
  const piAppended: AppendedEntry[] = options.separatePiAppended ? [] : appended;
  const sessionAppended: AppendedEntry[] = appended;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];

  const pushPi = (type: string, data?: unknown) => {
    piAppended.push({ type, data });
  };
  const pushSession = (type: string, data?: unknown) => {
    sessionAppended.push({ type, data });
  };

  const pi: any = {
    on(name: string, fn: (event: any, ctx: any) => any) {
      handlers.set(name, fn);
    },
    appendEntry: options.piAppendEntry ? options.piAppendEntry(pushPi) : pushPi,
    sendMessage() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, spec.handler);
    },
    registerTool() {},
    registerMessageRenderer() {},
    events: { emit() {} },
  };

  const branch = options.branch ?? defaultBranch();

  const ctx: any = {
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry: options.sessionAppendCustomEntry
        ? options.sessionAppendCustomEntry(pushSession)
        : (type: string, data?: unknown) => {
            pushSession(type, data);
            return "id";
          },
      appendCustomMessageEntry(type: string, content: string, _display: boolean, details?: unknown) {
        sessionAppended.push({ type, data: { content, details } });
        return "id";
      },
      getSessionDir: () => sessionDir,
      getSessionId: () => "test",
    },
    getContextUsage: () => ({ tokens: 600000, contextWindow: 1000000 }),
    model: { id: "m", provider: "p", name: "M" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
      getProviderAuth: async () => undefined,
    },
    ui: {
      setStatus() {},
      setWidget() {},
      notify(message: string) {
        notifications.push(message);
      },
      select: async () => undefined,
    },
  };

  return { handlers, commands, notifications, ctx, pi, piAppended, sessionAppended, appended, branch };
}

async function boot(options?: Parameters<typeof bootExtension>[0]) {
  const harness = bootExtension(options);
  const extension = (await import("../index.js")).default;
  extension(harness.pi);
  return harness;
}

describe("reload rearm (issue #6)", () => {
  it("rearms the turn_end budget gate after a reload so recovered pending work still flushes", async () => {
    const { handlers, ctx, appended } = await boot();

    await handlers.get("session_start")!({}, ctx);

    // Gate reachable without a fresh turn_end batch: the reload probe found
    // recoverable work, so the budget-crossing turn_end below must flush it
    // even though event.toolResults is empty.
    await handlers.get("turn_end")!(
      { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex: 2 },
      ctx,
    );

    expect(summarizerCalls).toBeGreaterThan(0);

    const indexEntry = appended.find((e) => e.type === "context-prune-index");
    expect(indexEntry).toBeDefined();

    // Prune visibility: the raw tc1 toolResult must now render as a stub.
    const rawMessages = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message);
    const res = await handlers.get("context")!({ messages: rawMessages }, ctx);
    const prunedToolResult = res.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "tc1");
    expect(prunedToolResult).toBeDefined();
    const prunedText = Array.isArray(prunedToolResult.content)
      ? prunedToolResult.content.map((c: any) => c.text).join("\n")
      : String(prunedToolResult.content);
    expect(prunedText).toContain("context_tree_query");

    const callsAfterFirstFlush = summarizerCalls;

    // Second identical turn_end: the flag was cleared by the first flush, and
    // the work is now summarized, so this must not re-trigger the summarizer.
    await handlers.get("turn_end")!(
      { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex: 3 },
      ctx,
    );

    expect(summarizerCalls).toBe(callsAfterFirstFlush);

    // ── Per-attempt flush-metrics entry (issue #6, Task 5) ──────────────────
    const flushMetricsEntries = appended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    const fm = flushMetricsEntries[0].data as any;
    expect(fm.trigger).toBe("rearmed");
    expect(fm.outcome).toBe("summarized");
    expect(fm.capturedBatches).toBe(1);
    expect(fm.processedBatches).toBe(1);
    expect(fm.metrics.frontierGapTokens).toBeGreaterThan(0);

    // Empty-attempt: message_end's unconditional flushPending rescans and finds
    // nothing (the only batch was already summarized above). One entry per
    // attempt, including empty ones.
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const flushMetricsEntriesAfterEmpty = appended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntriesAfterEmpty.length).toBe(2);
    const empty = flushMetricsEntriesAfterEmpty[1].data as any;
    expect(empty.trigger).toBe("message-end");
    expect(empty.outcome).toBe("empty");
    expect(empty.capturedBatches).toBe(0);
    expect(empty.processedBatches).toBe(0);
  });

  it("agent_end shows 'recovered pending (reload)' when rearmed but the in-memory queue is empty", async () => {
    const { handlers, ctx } = await boot();

    await handlers.get("session_start")!({}, ctx);

    const statusCalls: unknown[] = [];
    ctx.ui.setStatus = (_id: string, text?: string) => statusCalls.push(text);

    await handlers.get("agent_end")!({}, ctx);

    expect(statusCalls).toContain("\u2502 prune: recovered pending (reload)");
  });

  it("reports a rescan failure to console.error and leaves rearmedPending false, without failing session_start (G4)", async () => {
    // Spec (Component 2, Rescan failure): "if the reload rearm probe throws,
    // console.error ... and leave rearmedPending = false - reload must never
    // fail because of the probe." The probe's own try/catch in session_start
    // can only observe a failure if the branch rescan actually propagates
    // one out of capturePendingBatches for this call site.
    const { handlers, ctx } = await boot();

    let getBranchCalls = 0;
    const realGetBranch = ctx.sessionManager.getBranch;
    ctx.sessionManager.getBranch = () => {
      getBranchCalls++;
      // Within session_start, getBranch() is called once each by
      // indexer/stats/frontier reconstruction (calls 1-3) before the reload
      // rearm probe's own rescan (call 4). Fail only call 4 so the earlier
      // reconstruction steps are unaffected and the failure is isolated to
      // the probe.
      if (getBranchCalls === 4) {
        throw new Error("simulated branch rescan failure");
      }
      return realGetBranch();
    };

    const errorSpy: unknown[][] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    try {
      await handlers.get("session_start")!({}, ctx);
    } finally {
      console.error = realConsoleError;
    }

    expect(errorSpy.some((args) => String(args[0]).includes("reload rearm probe"))).toBe(true);

    // rearmedPending must have stayed false: a toolResult-free turn_end must
    // not reach the budget/delta gate (the observable proxy for the flag,
    // exercised elsewhere in this file), so no flush/summarizer call happens.
    const callsBefore = summarizerCalls;
    await handlers.get("turn_end")!(
      { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex: 2 },
      ctx,
    );
    expect(summarizerCalls).toBe(callsBefore);
  });

  it("non-rearmed turn_end with an all-excluded batch does not evaluate the budget gate (main parity)", async () => {
    // Regression for the rearmed=false path: a turn whose toolResults are
    // entirely protected (so trimBatchToPendingRange yields null) must
    // return before touching previousFraction or the budget/delta gate —
    // exactly main's `if (!batch) return;` — even when pendingBatches
    // already holds a batch queued by an earlier turn.
    const { handlers, ctx, appended } = await boot({ branch: [], protectedTools: ["secret_tool"] });

    await handlers.get("session_start")!({}, ctx);

    // Turn 1: a non-protected batch, low usage — pushes into pendingBatches
    // without triggering a flush.
    ctx.getContextUsage = () => ({ tokens: 100, contextWindow: 1000000 });
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-a", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc-a", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 5,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);
    const callsBeforeTurn2 = summarizerCalls;

    // Turn 2: every tool call is protected, so trimBatchToPendingRange
    // returns null — but usage now crosses the budget threshold. Main
    // returns before the gate for this turn; the leftover batch from turn 1
    // must not cause a flush here.
    ctx.getContextUsage = () => ({ tokens: 900000, contextWindow: 1000000 });
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-b", name: "secret_tool", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc-b", toolName: "secret_tool", content: [{ type: "text", text: "y".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 6,
      },
      ctx,
    );

    expect(summarizerCalls).toBe(callsBeforeTurn2);
    expect(appended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);
  });

  it("still writes the flush-metrics entry when chain compression fails", async () => {
    // The chain-compression block routes its appendEntry through the same
    // sessionManager.appendCustomEntry as the rest of the session-delivery
    // path (delivery: "session" here). Throwing only for the chain entry's
    // customType breaks compressEligible's write without touching the index /
    // frontier / stats writes the summarization phase already made.
    //
    // The compressor only attempts a write when a chain is actually eligible:
    // closed (has a final text-only assistant turn) AND older than the
    // rolling window (bootExtension hardcodes chainCompression.rollingWindow
    // to 3 — see the settings fixture above). A single closed chain never
    // clears that window, so the fixture below builds four independent
    // closed chains (separate user turns, so each becomes its own captured
    // batch and gets its own per-batch summary before compression runs) —
    // the oldest one becomes eligible and drives the injected throw. A local
    // counter proves the throw actually fired, so this test can never go
    // vacuous again.
    let chainWriteAttempts = 0;
    const { handlers, ctx, appended } = await boot({
      chainCompressionEnabled: true,
      branch: closedChainBranch(4),
      sessionAppendCustomEntry: (push) => (type: string, data?: unknown) => {
        if (type === "context-prune-chain") {
          chainWriteAttempts++;
          throw new Error("simulated chain-compression persistence failure");
        }
        push(type, data);
        return "id";
      },
    });

    await handlers.get("session_start")!({}, ctx);

    // message_end drives an agent-message flush directly (no reload rearm
    // needed): captures the four batches, summarizes them, then attempts
    // chain compression on the oldest eligible chain, which fails and is
    // swallowed.
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      ctx,
    );

    // Positive proof the injected throw was actually exercised (not vacuous).
    expect(chainWriteAttempts).toBeGreaterThan(0);

    const flushMetricsEntries = appended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    const fm = flushMetricsEntries[0].data as any;
    expect(fm.outcome).toBe("summarized");
    expect(fm.trigger).toBe("message-end");
    expect(fm.capturedBatches).toBe(4);
    expect(fm.processedBatches).toBe(4);
  });

  it("binds the sessionManager appender before the empty-capture exit, so an empty session-delivery flush still lands via sessionManager", async () => {
    // Regression: the sessionManager-backed appender used to bind only after
    // a non-empty capture, so an empty rescan on a session-delivery flush
    // fell back to pi.appendEntry for the flush-metrics emit — a stale-pi
    // drop risk (print-mode, reload). message_end always flushes with
    // delivery: "session"; an empty branch makes the rescan find nothing.
    const { handlers, ctx, piAppended, sessionAppended } = await boot({
      branch: [],
      separatePiAppended: true,
      piAppendEntry: (push) => (type: string, data?: unknown) => {
        push(type, data);
        throw new Error("simulated stale runtime: pi.appendEntry unavailable");
      },
    });

    await handlers.get("session_start")!({}, ctx);

    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const flushMetricsEntries = sessionAppended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    expect((flushMetricsEntries[0].data as any).outcome).toBe("empty");
    expect(piAppended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);
  });

  it("still writes the flush-metrics entry via sessionManager when pi.appendEntry is stale (print-mode) during session delivery", async () => {
    // Simulates a stale runtime `pi` reference during print-mode: any call
    // that still routes through pi.appendEntry throws, as it would against a
    // dead/replaced runtime.
    const { handlers, ctx, piAppended, sessionAppended } = await boot({
      separatePiAppended: true,
      piAppendEntry: (push) => (type: string, data?: unknown) => {
        push(type, data);
        throw new Error("simulated stale runtime: pi.appendEntry unavailable");
      },
    });

    await handlers.get("session_start")!({}, ctx);

    // message_end drives a session-delivery flush (delivery: "session").
    // Under the pre-fix unconditional pi.appendEntry, this entry is lost to
    // the swallowing try/catch because pi.appendEntry throws above.
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      ctx,
    );

    const flushMetricsEntries = sessionAppended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    const fm = flushMetricsEntries[0].data as any;
    expect(fm.outcome).toBe("summarized");
    expect(fm.trigger).toBe("message-end");

    // Confirms the routing decision, not just a lucky duplicate write: the
    // stale pi.appendEntry must never be the source of this entry.
    expect(piAppended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);
  });

  it("includes a persisted summary custom_message entry in the largest-chain-share denominator (G1)", async () => {
    // Component 1 (spec): denominator = per-message chars over the entire
    // branch projection, INCLUDING retained custom_message summary entries.
    // A pre-fix `e.type === "message"` filter drops them, so the chain's
    // share comes out inflated (denominator too small).
    //
    // The custom_message sits between two final text-only assistant
    // messages so it lands outside both the chain range and the open-cycle
    // segment (see src/context-metrics.test.ts's matching pure-level test) --
    // isolating the denominator effect from any open-segment interaction.
    const closedChain = closedChainBranch(1); // user -> assistant toolCall -> toolResult -> final text-only assistant
    const summaryEntry = {
      type: "custom_message",
      customType: "context-prune-summary",
      content: "s".repeat(3000),
      display: false,
      details: {},
      timestamp: new Date().toISOString(),
    };
    const closer = {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() + 100000 },
    };
    const branch = [...closedChain, summaryEntry, closer];

    const { handlers, commands, notifications, ctx } = await boot({ branch });
    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    await handlers.get("session_start")!({}, ctx);

    await commands.get("pruner")!("status", ctx);
    const text = notifications[notifications.length - 1] as string;

    const chainChars = closedChain.map((e: any) => JSON.stringify(e.message).length).reduce((a, b) => a + b, 0);
    const totalWithSummary = [...closedChain.map((e: any) => e.message), summaryEntry, closer.message]
      .map((m) => JSON.stringify(m).length)
      .reduce((a, b) => a + b, 0);
    const expectedPct = Math.round((100 * chainChars) / totalWithSummary);
    const inflatedPct = Math.round(
      (100 * chainChars) / closedChain.map((e: any) => JSON.stringify(e.message).length).reduce((a, b) => a + b, 0),
    );

    expect(text).toContain(`chain share:  ${expectedPct}%`);
    expect(expectedPct).toBeLessThan(inflatedPct);
  });

  it("feeds persisted custom_message steers into chain detection via the shared projection (#13)", async () => {
    // A production-feed regression: chain detection/compaction/metrics must
    // all see custom_message entries projected as role "custom" (src/batch-
    // capture.ts projectBranchMessages), not just plain "message" entries.
    // A non-pruner customType (isChainAnchorCustom) opens a chain while idle
    // and anchors resolveRange the same way a user message does; a pruner-
    // namespaced customType (context-prune-*) must NOT anchor one.
    const t0 = new Date().toISOString();
    let t = new Date(t0).getTime();

    const customAnchoredChain: any[] = [
      {
        type: "custom_message",
        customType: "pi-gauntlet-transition-recovery",
        content: [{ type: "text", text: "continue" }],
        timestamp: t0,
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-custom", name: "read", arguments: {} }] },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-custom",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(400) }],
          timestamp: (t += 1000),
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done custom" }], timestamp: (t += 1000) },
      },
    ];

    // A second closed, user-anchored chain so the custom-anchored chain above
    // is not the newest/frontier chain (rollingWindow: 0 makes every closed
    // chain not already compressed eligible regardless, but this mirrors a
    // realistic multi-turn session and rules out any "only chain" special case).
    const trailingChain: any[] = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "do more" }], timestamp: (t += 1000) } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-trail", name: "read", arguments: {} }] },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-trail",
          toolName: "read",
          content: [{ type: "text", text: "y".repeat(400) }],
          timestamp: (t += 1000),
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done trailing" }], timestamp: (t += 1000) },
      },
    ];

    const branch = [...customAnchoredChain, ...trailingChain];

    const { handlers, ctx, appended } = await boot({ chainCompressionEnabled: true, rollingWindow: 0, branch });

    await handlers.get("session_start")!({}, ctx);
    await handlers.get("turn_end")!(
      { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex: 2 },
      ctx,
    );
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const chainEntries = appended.filter((e) => e.type === "context-prune-chain");
    const anchoredAtCustom = chainEntries.find(
      (e) => (e.data as any).startUserTimestamp === new Date(t0).getTime(),
    );
    expect(anchoredAtCustom).toBeDefined();
  });

  it("does not let a pruner-namespaced custom_message (context-prune-*) anchor a chain (#13)", async () => {
    const t0 = new Date().toISOString();
    let t = new Date(t0).getTime();

    const pruneSummaryEntry: any[] = [
      {
        type: "custom_message",
        customType: "context-prune-summary",
        content: [{ type: "text", text: "prior summary" }],
        timestamp: t0,
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-p", name: "read", arguments: {} }] },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-p",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(400) }],
          timestamp: (t += 1000),
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done p" }], timestamp: (t += 1000) },
      },
    ];

    const { handlers, ctx, appended } = await boot({ chainCompressionEnabled: true, rollingWindow: 0, branch: pruneSummaryEntry });

    await handlers.get("session_start")!({}, ctx);
    await handlers.get("turn_end")!(
      { toolResults: [], message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, turnIndex: 2 },
      ctx,
    );
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const chainEntries = appended.filter((e) => e.type === "context-prune-chain");
    const anchoredAtSummary = chainEntries.find(
      (e) => (e.data as any).startUserTimestamp === new Date(t0).getTime(),
    );
    expect(anchoredAtSummary).toBeUndefined();
  });

  it("frontier-gap trigger fires at turn_end when the un-pruned tail exceeds the threshold (#13)", async () => {
    const { handlers, ctx, notifications, appended } = await boot({
      autoBudgetThreshold: null,
      frontierGapThresholdTokens: 10,
    });

    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    await handlers.get("session_start")!({}, ctx);

    // defaultBranch() already carries an unsummarized ~400-char toolResult
    // (~100 tokens), well past the threshold of 10.
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 2,
      },
      ctx,
    );

    const flushMetricsEntries = appended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    const fm = flushMetricsEntries[0].data as any;
    expect(fm.trigger).toBe("frontier-gap");
    expect(fm.metrics.frontierGapTokens).toBeGreaterThanOrEqual(10);

    expect(notifications.some((n) => n.includes("un-pruned tail exceeded frontier gap threshold"))).toBe(true);
  });

  it("budget trigger takes precedence over frontier-gap when both conditions are met at turn_end (#13)", async () => {
    const { handlers, ctx, appended } = await boot({
      autoBudgetThreshold: 0.5,
      frontierGapThresholdTokens: 10,
    });

    await handlers.get("session_start")!({}, ctx);

    // Usage fraction 0.9 crosses the 0.5 budget threshold; defaultBranch()'s
    // un-pruned tail also crosses the 10-token gap threshold. Budget must win.
    ctx.getContextUsage = () => ({ tokens: 900000, contextWindow: 1000000 });

    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 2,
      },
      ctx,
    );

    const flushMetricsEntries = appended.filter((e) => e.type === "context-prune-flush-metrics");
    expect(flushMetricsEntries.length).toBe(1);
    expect((flushMetricsEntries[0].data as any).trigger).toBe("budget");
  });

  it("frontier-gap trigger stays inert when frontierGapThresholdTokens is unset (default null), even with a huge un-pruned tail (#13)", async () => {
    const { handlers, ctx, appended } = await boot({
      autoBudgetThreshold: null,
    });

    await handlers.get("session_start")!({}, ctx);
    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 2,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);
  });

  it("frontier-gap cadence: a partial-failure flush persists the surviving prefix and advances the frontier; the next gap-triggered flush advances it further (#13)", async () => {
    const { handlers, ctx, appended } = await boot({
      autoBudgetThreshold: null,
      frontierGapThresholdTokens: 10,
      branch: [],
    });

    await handlers.get("session_start")!({}, ctx);
    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    // Turn 1: branch still empty -> frontierGapTokens is 0 -> no flush, even
    // though this turn's own toolResults are pushed into pendingBatches.
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-warmup", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc-warmup", toolName: "read", content: [{ type: "text", text: "w".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 1,
      },
      ctx,
    );
    expect(appended.some((e) => e.type === "context-prune-flush-metrics")).toBe(false);

    // Grow the branch with two independent unindexed batches (tc-a, tc-b) —
    // capturePendingBatches rescans the branch, not the in-memory queue, so
    // this is what actually makes the upcoming flush see two batches.
    let t = Date.now();
    ctx.sessionManager.getBranch().push(...pendingBatchEntries("tc-a", "a".repeat(400), (t += 1000)));
    ctx.sessionManager.getBranch().push(...pendingBatchEntries("tc-b", "b".repeat(400), (t += 1000)));

    let callCount = 0;
    streamImpl = () => {
      callCount++;
      summarizerCalls++;
      if (callCount === 2) return errStream("simulated summarizer failure on second batch");
      return okStream();
    };

    // Turn 2: gap now over threshold (tc-a + tc-b unsummarized) -> flush fires,
    // processes tc-a successfully, tc-b's summarization call fails.
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-a", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc-a", toolName: "read", content: [{ type: "text", text: "a".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 2,
      },
      ctx,
    );

    let frontierEntries = appended.filter((e) => e.type === "context-prune-frontier");
    expect(frontierEntries.length).toBe(1);
    const firstFrontier = frontierEntries[0].data as any;
    expect(firstFrontier.lastAttemptedToolCallId).toBe("tc-a");

    // Grow the branch again (tc-b is still unsummarized/pending after the
    // restore; add tc-c as this turn's new work) — gap stays over threshold.
    ctx.sessionManager.getBranch().push(...pendingBatchEntries("tc-c", "c".repeat(400), (t += 1000)));

    // Turn 3: gap still over threshold -> flush fires again, this time both
    // tc-b (restored) and tc-c succeed (streamImpl only fails on call #2).
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc-c", name: "read", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "tc-c", toolName: "read", content: [{ type: "text", text: "c".repeat(400) }], timestamp: Date.now() },
        ],
        turnIndex: 3,
      },
      ctx,
    );

    frontierEntries = appended.filter((e) => e.type === "context-prune-frontier");
    expect(frontierEntries.length).toBe(2);
    const secondFrontier = frontierEntries[1].data as any;
    expect(secondFrontier.lastAttemptedTimestamp).toBeGreaterThan(firstFrontier.lastAttemptedTimestamp);
  });
});

describe("supersede floor cadence (spec 2026-09-07)", () => {
  const PROTECTED_PATH = "/x/skills/a/SKILL.md";
  const PROTECTED_GLOB = "**/skills/**/*.md";

  function protectedRead(id: string, ts: number, text = `content-${id}`): any[] {
    return [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: PROTECTED_PATH } }] },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], timestamp: ts },
      },
    ];
  }

  function bashCall(id: string, ts: number, text = "x".repeat(400)): any[] {
    return [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] } },
      { type: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], timestamp: ts } },
    ];
  }

  async function render(branch: any[], handlers: Map<string, any>, ctx: any): Promise<any[]> {
    const rawMessages = branch.filter((e) => e.type === "message").map((e) => e.message);
    const res = await handlers.get("context")!({ messages: rawMessages }, ctx);
    return res?.messages ?? rawMessages;
  }

  function toolResultText(messages: any[], toolCallId: string): string | undefined {
    const m = messages.find((m: any) => m.role === "toolResult" && m.toolCallId === toolCallId);
    if (!m) return undefined;
    return Array.isArray(m.content) ? m.content.map((c: any) => c.text).join("\n") : String(m.content);
  }

  it("no rewrite between two protected reads leaves both verbatim", async () => {
    const branch: any[] = [];
    const { handlers, ctx } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r1", 10));
    await handlers.get("session_start")!({}, ctx);
    // Prime: consumes the session_start floor=0 while only the first read
    // exists (no candidate yet), so it cannot spuriously activate anything.
    await render(branch, handlers, ctx);

    branch.push(...protectedRead("r2", 30));
    // No flush/compression/cold-cache event between the two reads.
    const rendered = await render(branch, handlers, ctx);

    expect(toolResultText(rendered, "r1")).toBe("content-r1");
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  it("an indexed flush whose unprotected result precedes the older read stubs it", async () => {
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...bashCall("bash1", 10));
    branch.push(...protectedRead("r1", 20));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime: consume floor=0, single occurrence so far

    branch.push(...protectedRead("r2", 30));

    // bootExtension's default ctx.getContextUsage() is 0.6, above the 0.5
    // autoBudgetThreshold, so this turn_end flushes immediately.
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bash1", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bash1", toolName: "bash", content: [{ type: "text", text: "x".repeat(400) }], timestamp: 10 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-index")).toBe(true);

    const rendered = await render(branch, handlers, ctx);
    expect(toolResultText(rendered, "r1")).toBe(supersededStub(PROTECTED_PATH));
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
    // Phase 1 (unrelated to supersede) already stubs bash1's own result.
    expect(toolResultText(rendered, "bash1")).not.toBe("x".repeat(400));
  });

  it("an indexed flush whose unprotected result follows the older read leaves it verbatim (floor is positional)", async () => {
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r1", 10));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime

    branch.push(...bashCall("bash1", 20));
    branch.push(...protectedRead("r2", 30));

    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bash1", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bash1", toolName: "bash", content: [{ type: "text", text: "x".repeat(400) }], timestamp: 20 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-index")).toBe(true);

    const rendered = await render(branch, handlers, ctx);
    // Floor = 20 (bash1's resultTimestamp); r1's timestamp (10) is before it,
    // so the floor never reaches it even though a real rewrite just happened.
    expect(toolResultText(rendered, "r1")).toBe("content-r1");
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  it("a protected-only turn sets no floor", async () => {
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r1", 10));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime

    branch.push(...protectedRead("r2", 30));

    await handlers.get("turn_end")!(
      {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "r1", name: "read", arguments: { path: PROTECTED_PATH } },
            { type: "toolCall", id: "r2", name: "read", arguments: { path: PROTECTED_PATH } },
          ],
        },
        toolResults: [
          { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "content-r1" }], timestamp: 10 },
          { role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "content-r2" }], timestamp: 30 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-index")).toBe(false);

    const rendered = await render(branch, handlers, ctx);
    expect(toolResultText(rendered, "r1")).toBe("content-r1");
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  const COLD_CACHE_EVENTS = ["session_start", "session_tree", "model_select", "session_compact", "thinking_level_select"];

  for (const eventName of COLD_CACHE_EVENTS) {
    it(`${eventName} activates every pending supersession (floor = 0)`, async () => {
      const branch: any[] = [];
      const { handlers, ctx } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

      branch.push(...protectedRead("r1", 10));
      await handlers.get("session_start")!({}, ctx);
      await render(branch, handlers, ctx); // prime

      branch.push(...protectedRead("r2", 30));
      const beforeEvent = await render(branch, handlers, ctx);
      expect(toolResultText(beforeEvent, "r1")).toBe("content-r1");
      expect(toolResultText(beforeEvent, "r2")).toBe("content-r2");

      await handlers.get(eventName)!({}, ctx);

      const afterEvent = await render(branch, handlers, ctx);
      expect(toolResultText(afterEvent, "r1")).toBe(supersededStub(PROTECTED_PATH));
      expect(toolResultText(afterEvent, "r2")).toBe("content-r2");
    });
  }

  it("stays sticky after cold-cache activation: the older read stays stubbed on a later render with no new event", async () => {
    const branch: any[] = [];
    const { handlers, ctx } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r1", 10));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime

    branch.push(...protectedRead("r2", 30));
    await handlers.get("model_select")!({}, ctx);

    const first = await render(branch, handlers, ctx);
    expect(toolResultText(first, "r1")).toBe(supersededStub(PROTECTED_PATH));

    const second = await render(branch, handlers, ctx);
    expect(toolResultText(second, "r1")).toBe(supersededStub(PROTECTED_PATH));
    expect(toolResultText(second, "r2")).toBe("content-r2");
  });

  it("chain compression lowers the floor: the older read stubs inside the compressed chain's <protected-output>, the newer read stays raw", async () => {
    // Chain 0 mixes an unprotected bash call with the OLD protected read in the
    // same turn, so the chain gets a real per-batch summary (a fully-protected
    // chain is intentionally never compressed - chain-compressor.ts fullyProtected
    // guard) while still carrying protectedToolCallIds for the read.
    function closedChain(index: number, extraToolCalls: { id: string; name: string; args: any; text: string }[], startTs: number) {
      const msgs: any[] = [];
      let t = startTs;
      msgs.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `do task ${index}` }], timestamp: t } });
      msgs.push({
        type: "message",
        message: {
          role: "assistant",
          content: extraToolCalls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
        },
      });
      for (const c of extraToolCalls) {
        t += 100;
        msgs.push({
          type: "message",
          message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: c.text }], timestamp: t },
        });
      }
      t += 1000;
      msgs.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `done ${index}` }], timestamp: t } });
      return { msgs, startUserTimestamp: startTs };
    }

    const chain0 = closedChain(
      0,
      [
        { id: "c0-bash", name: "bash", args: {}, text: "x".repeat(400) },
        { id: "c0-read", name: "read", args: { path: PROTECTED_PATH }, text: "content-r1" },
      ],
      1000,
    );
    const chain1 = closedChain(1, [{ id: "c1-bash", name: "bash", args: {}, text: "y".repeat(400) }], 5000);
    const chain2 = closedChain(2, [{ id: "c2-bash", name: "bash", args: {}, text: "z".repeat(400) }], 9000);
    const chain3 = closedChain(3, [{ id: "c3-bash", name: "bash", args: {}, text: "w".repeat(400) }], 13000);

    const branch: any[] = [...chain0.msgs, ...chain1.msgs, ...chain2.msgs, ...chain3.msgs];
    const { handlers, ctx, appended } = await boot({
      protectedPaths: [PROTECTED_GLOB],
      chainCompressionEnabled: true,
      rollingWindow: 3,
      branch,
    });

    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime: only one occurrence of the protected path exists so far

    // message_end drives an unconditional agent-message flush: summarizes the
    // four turns, then compresses whichever chains fall outside rollingWindow=3
    // (chain0, the oldest of four).
    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const chainEntries = appended.filter((e) => e.type === "context-prune-chain");
    const chain0Entry = chainEntries.find((e) => (e.data as any).startUserTimestamp === chain0.startUserTimestamp);
    if (!chain0Entry) {
      throw new Error(`chain0 was not compressed - chainEntries: ${JSON.stringify(chainEntries.map((e) => e.data))}`);
    }
    expect(((chain0Entry.data as any).protectedToolCallIds ?? []).includes("c0-read")).toBe(true);

    // The newer read of the same path, added after compression - never indexed,
    // never compressed, must stay the winner.
    branch.push(...protectedRead("r2", 20000));

    const rendered = await render(branch, handlers, ctx);

    const compressedChainMsg = rendered.find(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.text?.includes(`id="${(chain0Entry.data as any).blockId}"`),
    );
    expect(compressedChainMsg).toBeDefined();
    const chainText = compressedChainMsg.content[0].text as string;
    expect(chainText).toContain('<protected-output tool="read">');
    expect(chainText).toContain(supersededStub(PROTECTED_PATH));

    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  it("a skipped-trivial batch (below minBatchChars) sets no floor", async () => {
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    // minBatchChars is hardcoded to 1 in this harness's settings fixture, so an
    // empty result (0 raw chars) is the only way to land below it and take the
    // trivial path instead of an actual LLM call.
    branch.push(...bashCall("bash1", 10, ""));
    branch.push(...protectedRead("r1", 20));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime

    branch.push(...protectedRead("r2", 30));

    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bash1", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bash1", toolName: "bash", content: [{ type: "text", text: "" }], timestamp: 10 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-index")).toBe(false);
    const frontierEntries = appended.filter((e) => e.type === "context-prune-frontier");
    expect(frontierEntries.length).toBe(1);
    expect((frontierEntries[0].data as any).outcome).toBe("skipped-trivial");

    const rendered = await render(branch, handlers, ctx);
    expect(toolResultText(rendered, "r1")).toBe("content-r1");
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  it("a skipped-oversized batch (summary longer than raw) sets no floor", async () => {
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    // A 1-char raw result clears minBatchChars=1 (not trivial) but the mocked
    // summarizer's decorated output is always longer than 1 char, so
    // shouldSkipOversized (index.ts) fires and the batch never indexes.
    branch.push(...bashCall("bash1", 10, "x"));
    branch.push(...protectedRead("r1", 20));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime

    branch.push(...protectedRead("r2", 30));

    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bash1", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bash1", toolName: "bash", content: [{ type: "text", text: "x" }], timestamp: 10 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    expect(appended.some((e) => e.type === "context-prune-index")).toBe(false);
    const frontierEntries = appended.filter((e) => e.type === "context-prune-frontier");
    expect(frontierEntries.length).toBe(1);
    expect((frontierEntries[0].data as any).outcome).toBe("skipped-oversized");

    const rendered = await render(branch, handlers, ctx);
    expect(toolResultText(rendered, "r1")).toBe("content-r1");
    expect(toolResultText(rendered, "r2")).toBe("content-r2");
  });

  it("a dedup alias registered in a fully-deduped (skipped-deduped) batch still lowers the floor", async () => {
    // Batch 1 (turn 1): a real bash result R, flushed and indexed normally.
    // Its own resultTimestamp (500) is deliberately AFTER the older protected
    // read (100), so on its own it could never explain that read's
    // activation. Batch 2 (turn 2) resends the identical bash content at an
    // EARLIER timestamp (90, <= the older read's 100) — content-hash dedup
    // (indexer.lookupByContent/registerDuplicate) turns it into a pure alias,
    // no LLM call, batch outcome skipped-deduped — but the alias's own
    // timestamp still feeds floorSources (index.ts, unconditionally, before
    // the per-batch outcome switch), so it alone must be what activates the
    // supersession, isolating G4's "alias counts regardless of outcome" claim
    // from the ordinary indexed-flush floor path already covered above.
    const R = "R".repeat(400);
    const branch: any[] = [];
    const { handlers, ctx, appended } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r_old", 100));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime: single occurrence so far

    branch.push(...bashCall("bashOrig", 500, R));
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bashOrig", name: "bash", arguments: {} }] },
        toolResults: [{ role: "toolResult", toolCallId: "bashOrig", toolName: "bash", content: [{ type: "text", text: R }], timestamp: 500 }],
        turnIndex: 1,
      },
      ctx,
    );
    expect(appended.some((e) => e.type === "context-prune-index")).toBe(true);

    branch.push(...bashCall("bashDup", 90, R));
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bashDup", name: "bash", arguments: {} }] },
        toolResults: [{ role: "toolResult", toolCallId: "bashDup", toolName: "bash", content: [{ type: "text", text: R }], timestamp: 90 }],
        turnIndex: 2,
      },
      ctx,
    );

    const dedupAliasEntries = appended.filter((e) => e.type === "context-prune-dedup-alias");
    expect(dedupAliasEntries.length).toBe(1);
    const frontierEntries = appended.filter((e) => e.type === "context-prune-frontier");
    expect(frontierEntries[frontierEntries.length - 1].data && (frontierEntries[frontierEntries.length - 1].data as any).outcome).toBe(
      "skipped-deduped",
    );
    // The alias's own resultTimestamp (90) is <= the older read's (100) — the
    // property that lets it, alone, explain the activation below.

    branch.push(...protectedRead("r_new", 99999));
    const rendered = await render(branch, handlers, ctx);

    expect(toolResultText(rendered, "r_old")).toBe(supersededStub(PROTECTED_PATH));
    expect(toolResultText(rendered, "r_new")).toBe("content-r_new");
  });

  it("a chain-compression floor (anchor timestamp) is distinguishable from the indexed-result floor", async () => {
    // Every unprotected indexed result across all four chains (5000/7000/8000)
    // is timestamped AFTER the older protected read (100). Only chain0's
    // startUserTimestamp (10, the compression anchor) is timestamped before
    // it — so only compressEligible's separate lowerFloor(startUserTimestamp)
    // call (index.ts, after the per-batch flush's own lowerFloor call) can
    // explain the older read's activation, isolating the chain-anchor floor
    // source from the ordinary indexed-batch floor source already covered
    // above.
    function closedChain(startTs: number, toolCalls: { id: string; name: string; args: any; text: string }[]) {
      const msgs: any[] = [];
      msgs.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `task ${startTs}` }], timestamp: startTs } });
      msgs.push({
        type: "message",
        message: { role: "assistant", content: toolCalls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })) },
      });
      for (const c of toolCalls) {
        msgs.push({
          type: "message",
          message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: c.text }], timestamp: (c as any).ts },
        });
      }
      msgs.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `done ${startTs}` }], timestamp: startTs + 1 } });
      return msgs;
    }

    const chain0 = closedChain(10, [{ id: "c0-bash", name: "bash", args: {}, text: "x".repeat(400), ts: 5000 } as any]);
    const chain1 = closedChain(6000, [{ id: "c1-read", name: "read", args: { path: PROTECTED_PATH }, text: "content-r_old", ts: 100 } as any]);
    const chain2 = closedChain(9000, [{ id: "c2-bash", name: "bash", args: {}, text: "y".repeat(400), ts: 7000 } as any]);
    const chain3 = closedChain(13000, [{ id: "c3-bash", name: "bash", args: {}, text: "z".repeat(400), ts: 8000 } as any]);

    const branch: any[] = [...chain0, ...chain1, ...chain2, ...chain3];
    const { handlers, ctx, appended } = await boot({
      protectedPaths: [PROTECTED_GLOB],
      chainCompressionEnabled: true,
      rollingWindow: 3,
      branch,
    });

    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime: only c1-read exists so far, no second occurrence

    await handlers.get("message_end")!(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );

    const chainEntries = appended.filter((e) => e.type === "context-prune-chain");
    const chain0Entry = chainEntries.find((e) => (e.data as any).startUserTimestamp === 10);
    if (!chain0Entry) {
      throw new Error(`chain0 was not compressed - chainEntries: ${JSON.stringify(chainEntries.map((e) => e.data))}`);
    }
    expect((chain0Entry.data as any).startUserTimestamp).toBeLessThanOrEqual(100);

    branch.push(...protectedRead("r_new", 99999));
    const rendered = await render(branch, handlers, ctx);

    expect(toolResultText(rendered, "c1-read")).toBe(supersededStub(PROTECTED_PATH));
    expect(toolResultText(rendered, "r_new")).toBe("content-r_new");
  });

  it("combined lowering is monotonic: a later, higher-timestamp floor source cannot raise floor back up", async () => {
    // The task's suggested shape (one indexed flush + one compression in the
    // same turn) is exercised above by the chain-anchor test; this covers the
    // explicitly-allowed alternative instead: two floor sources, in either
    // order, across separate turns — the low value (10) is set first, the
    // high value (1000) arrives after, and the floor must stay clamped at the
    // min (10), not get overwritten by the later, higher call.
    const branch: any[] = [];
    const { handlers, ctx } = await boot({ protectedPaths: [PROTECTED_GLOB], branch });

    branch.push(...protectedRead("r_mid", 500));
    await handlers.get("session_start")!({}, ctx);
    await render(branch, handlers, ctx); // prime: single occurrence so far

    branch.push(...bashCall("bashLow", 10));
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bashLow", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bashLow", toolName: "bash", content: [{ type: "text", text: "x".repeat(400) }], timestamp: 10 },
        ],
        turnIndex: 1,
      },
      ctx,
    );

    branch.push(...bashCall("bashHigh", 1000));
    await handlers.get("turn_end")!(
      {
        message: { role: "assistant", content: [{ type: "toolCall", id: "bashHigh", name: "bash", arguments: {} }] },
        toolResults: [
          { role: "toolResult", toolCallId: "bashHigh", toolName: "bash", content: [{ type: "text", text: "y".repeat(400) }], timestamp: 1000 },
        ],
        turnIndex: 2,
      },
      ctx,
    );

    branch.push(...protectedRead("r_new", 99999));
    const rendered = await render(branch, handlers, ctx);

    // r_mid (500) sits between the low floor source (10) and the high one
    // (1000): only a floor still clamped at 10 explains its activation.
    expect(toolResultText(rendered, "r_mid")).toBe(supersededStub(PROTECTED_PATH));
    expect(toolResultText(rendered, "r_new")).toBe("content-r_new");
  });
});
