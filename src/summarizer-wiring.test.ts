import { describe, it, expect, mock } from "bun:test";

// Stub pi-ai's `stream` so runSummarization can be exercised without a network
// call. `streamImpl` is swapped per test to simulate primary/fallback outcomes.
let streamImpl: (model: any, input?: any, opts?: any) => any = () => {
  throw new Error("streamImpl not set");
};
mock.module("@earendil-works/pi-ai", () => ({
  stream: (...args: any[]) => streamImpl(...args),
}));

const { summarizeBatch } = await import("./summarizer.js");
const { FallbackController } = await import("./summarizer-fallback.js");
const { DEFAULT_CONFIG } = await import("./types.js");

const PRIMARY = { id: "primary-model", provider: "provider-a", name: "Primary" };
const SESSION = { id: "session-model", provider: "provider-b", name: "Session" };

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function okStream(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      // no events; runOnce only needs .result()
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

function errStream(message: string) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "error", errorMessage: message, content: [], usage: USAGE };
    },
  };
}

// Hangs until `opts.signal` (the combined caller+timeout signal runOnce
// passes to stream()) aborts. With no signal it never settles.
function hangingStream(opts: any) {
  const signal: AbortSignal | undefined = opts?.signal;
  const untilAbort = () =>
    new Promise<never>((_, reject) => {
      if (!signal) return; // no signal => never settles
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return {
    async *[Symbol.asyncIterator]() {
      await untilAbort();
    },
    async result() {
      return untilAbort();
    },
  };
}

// Emits `events` thinking_delta events spaced `gapMs` apart, then completes
// successfully — UNLESS `opts.signal` aborts mid-drip, in which case the
// current sleep rejects, exactly like a real provider stream cancelling on
// abort. This is what gives the idle-reset test teeth: if runOnce's in-loop
// bumpIdle() is ever removed, the idle timer fires at the configured window
// and the combined signal aborts, so this stream rejects instead of
// completing — the test then fails instead of passing vacuously.
function drippingStream(opts: any, text: string, events: number, gapMs: number) {
  const signal: AbortSignal | undefined = opts?.signal;
  const sleepOrAbort = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events; i++) {
        await sleepOrAbort(gapMs);
        yield { type: "thinking_delta" };
      }
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

interface Note {
  msg: string;
  level: string;
}

function makeCtx(notes: Note[], sessionModel: any = SESSION, primaryModel: any = PRIMARY) {
  return {
    model: sessionModel,
    modelRegistry: {
      find: () => primaryModel,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    },
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
  } as any;
}

function makeBatch() {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls: [
      { toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(50), isError: false },
    ],
  } as any;
}

const distinctConfig = { ...DEFAULT_CONFIG, summarizerModel: "provider-a/primary-model" };

describe("runSummarization wiring — same-model no-op (legacy path)", () => {
  it("summarizerModel=default: transient failure notifies error, returns null, controller untouched", async () => {
    streamImpl = () => errStream("provider overloaded");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), { ...DEFAULT_CONFIG, summarizerModel: "default" }, ctx, {
      controller,
    });
    expect(r).toBeNull();
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].msg).toContain("provider overloaded");
  });
});

describe("runSummarization wiring — enter fallback", () => {
  it("primary transient + fallback ok: returns summary, one warning, no error notify, sticky", async () => {
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("down") : okStream("- fallback summary"));
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r?.summaryText).toBe("- fallback summary");
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toContain("Primary");
    expect(warnings[0].msg).toContain("Session");
    expect(errors).toHaveLength(0);
  });

  it("steady-state after enter routes to the session model only (no primary call, no notify)", async () => {
    const seen: string[] = [];
    streamImpl = (model) => {
      seen.push(model.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("- ok");
    };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController(); // real clock: cooldown (10m) will not elapse in-test
    await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // enter
    seen.length = 0;
    notes.length = 0;
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // steady-state
    expect(r?.summaryText).toBe("- ok");
    expect(seen).toEqual([SESSION.id]); // primary never called again before cooldown
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — both-down + deferred warning", () => {
  it("primary + fallback both transient: null, error notify, enters fallback with owed warning", async () => {
    streamImpl = () => errStream("everything down");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r).toBeNull();
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(0); // warning is owed, not yet fired
    expect(errors).toHaveLength(1);

    // Next flush: fallback now succeeds -> owed warning fires once.
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("still down") : okStream("- rescued"));
    notes.length = 0;
    const r2 = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r2?.summaryText).toBe("- rescued");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
  });
});

describe("runSummarization wiring — abort", () => {
  it("re-throws when the signal is already aborted", async () => {
    streamImpl = () => okStream("- never");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const ac = new AbortController();
    ac.abort();
    await expect(
      summarizeBatch(makeBatch(), distinctConfig, ctx, { controller, signal: ac.signal }),
    ).rejects.toThrow();
  });
});

describe("runSummarization wiring — timeouts", () => {
  it("idle timeout (default model): transient warning, returns null", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 20, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r).toBeNull();
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/stalled/);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("ceiling timeout (idle disabled): transient warning mentioning ceiling", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r).toBeNull();
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/ceiling/);
  });

  it("option B: primary idle-times-out, session model rescues", async () => {
    streamImpl = (model, _i, opts) => (model.id === PRIMARY.id ? hangingStream(opts) : okStream("- rescued"));
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(r?.summaryText).toBe("- rescued");
    expect(controller.inFallback).toBe(true);
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1); // generic "enter" fallback warning
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("both time out: null, both-down notice at warning severity", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(r).toBeNull();
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("pre-aborted signal is not a timeout (throws, no warning)", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const ac = new AbortController();
    ac.abort();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    await expect(summarizeBatch(makeBatch(), cfg, ctx, { signal: ac.signal })).rejects.toThrow();
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });

  it("both timeouts disabled: okStream succeeds unchanged", async () => {
    streamImpl = () => okStream("- ok");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r?.summaryText).toBe("- ok");
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — idle reset keeps a flowing stream alive", () => {
  it("does not time out while events keep arriving within the idle window", async () => {
    // 6 events, 10ms apart = 60ms total > 25ms idle window; only survives if
    // the idle timer resets on every event (bumpIdle() inside the loop).
    streamImpl = (_m, _i, opts) => drippingStream(opts, "- flowing summary", 6, 10);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 25, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r?.summaryText).toBe("- flowing summary");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });
});
