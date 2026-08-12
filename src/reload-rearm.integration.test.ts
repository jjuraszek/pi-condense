import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let streamImpl: (model: any, input?: any, opts?: any) => any = () => {
  summarizerCalls++;
  return okStream();
};

mock.module("@earendil-works/pi-ai/compat", () => ({
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
    separatePiAppended?: boolean;
    piAppendEntry?: (push: (type: string, data?: unknown) => void) => (type: string, data?: unknown) => void;
    sessionAppendCustomEntry?: (push: (type: string, data?: unknown) => void) => (type: string, data?: unknown) => string;
    branch?: any[];
    protectedTools?: string[];
  } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-condense-rearm-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      contextPrune: {
        enabled: true,
        pruneOn: "agent-message",
        batchingMode: "agent-message",
        autoBudgetThreshold: 0.5,
        summarizerModel: "default",
        minBatchChars: 1,
        showPruneStatusLine: true,
        protectedTools: options.protectedTools ?? [],
        chainCompression: {
          enabled: options.chainCompressionEnabled ?? false,
          rollingWindow: 3,
          stripFinalAssistantThinking: true,
          fuseRangeSummary: true,
        },
      },
    }),
  );

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-condense-rearm-session-"));
  const appended: AppendedEntry[] = [];
  const piAppended: AppendedEntry[] = options.separatePiAppended ? [] : appended;
  const sessionAppended: AppendedEntry[] = appended;
  const handlers = new Map<string, (event: any, ctx: any) => any>();

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
    registerCommand() {},
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
      notify() {},
      select: async () => undefined,
    },
  };

  return { handlers, ctx, pi, piAppended, sessionAppended, appended, branch };
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

  it("recomputes the cached metrics snapshot on a turn_end whose toolResults produce no pushed batch (G3)", async () => {
    // Component 4 (spec): the snapshot cache recomputes at every enabled
    // turn_end carrying toolResults, unconditional on whether trim yields a
    // batch to push. Observed via the footer widget suffix (commands.ts's
    // pruneStatusText), which is rendered from the cache, not recomputed
    // itself — the honest seam here since the harness's pi.registerCommand
    // is a no-op stub and the registerCommands getCachedMetrics callback is
    // therefore unreachable from a test.
    const { handlers, ctx, branch } = await boot({ protectedTools: ["secret_tool"] });

    // Neutralize the budget/delta gate so this test only observes the
    // recompute, not a side-effect flush (harness default usage is 0.6,
    // above the fixture's 0.5 autoBudgetThreshold).
    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    await handlers.get("session_start")!({}, ctx);

    const statusCalls: unknown[] = [];
    ctx.ui.setStatus = (_id: string, text?: string) => statusCalls.push(text);

    // Force a render of the current (session_start-computed) cache.
    const rawBefore = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message);
    await handlers.get("context")!({ messages: rawBefore }, ctx);
    const textBefore = statusCalls[statusCalls.length - 1];

    // Grow the branch as Pi would before firing turn_end: a new assistant
    // turn with a large thinking block and a protected tool call, plus its
    // toolResult. Protected content is excluded from frontierGapTokens by
    // design, but NOT from openCycleThinkingTokens or largestChainSharePct —
    // so this turn still moves the cache if recomputed.
    const newAssistant = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "t".repeat(4000) },
          { type: "toolCall", id: "tc2", name: "secret_tool", arguments: {} },
        ],
      },
    };
    const newToolResult = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "secret_tool",
        content: [{ type: "text", text: "s".repeat(400) }],
        timestamp: Date.now(),
      },
    };
    branch.push(newAssistant, newToolResult);

    // This turn's toolResults are entirely protected, so trimBatchToPendingRange
    // returns null and no batch is pushed — the case this fix targets.
    await handlers.get("turn_end")!(
      { message: newAssistant.message, toolResults: [newToolResult.message], turnIndex: 3 },
      ctx,
    );

    const rawAfter = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message);
    await handlers.get("context")!({ messages: rawAfter }, ctx);
    const textAfter = statusCalls[statusCalls.length - 1];

    // Pre-fix, the cache is stale (computed once at session_start, on the
    // pre-growth branch) — the widget text does not move. Post-fix, the
    // turn_end recompute picks up the larger open segment/thinking.
    expect(textAfter).not.toBe(textBefore);
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

    const { handlers, ctx } = await boot({ branch });
    ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1000000 });

    const statusCalls: unknown[] = [];
    ctx.ui.setStatus = (_id: string, text?: string) => statusCalls.push(text);

    await handlers.get("session_start")!({}, ctx);

    const rawMessages = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message);
    await handlers.get("context")!({ messages: rawMessages }, ctx);
    const text = statusCalls[statusCalls.length - 1] as string;

    const chainChars = closedChain.map((e: any) => JSON.stringify(e.message).length).reduce((a, b) => a + b, 0);
    const totalWithSummary = [...closedChain.map((e: any) => e.message), summaryEntry, closer.message]
      .map((m) => JSON.stringify(m).length)
      .reduce((a, b) => a + b, 0);
    const expectedPct = Math.round((100 * chainChars) / totalWithSummary);
    const inflatedPct = Math.round(
      (100 * chainChars) / closedChain.map((e: any) => JSON.stringify(e.message).length).reduce((a, b) => a + b, 0),
    );

    expect(text).toContain(`chain ${expectedPct}%`);
    expect(expectedPct).toBeLessThan(inflatedPct);
  });
});
