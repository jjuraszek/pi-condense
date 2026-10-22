import { describe, it, expect } from "bun:test";
let streamImpl: (model: any, input?: any, opts?: any) => any = () => {
  throw new Error("streamImpl not set");
};
const { summarizeBatch, summarizeRange } = await import("./summarizer.js");
const { FallbackController } = await import("./summarizer-fallback.js");
const { DEFAULT_CONFIG, SUMMARIZER_IDLE_TIMEOUT_PRESETS } = await import("./types.js");

const PRIMARY = { id: "primary-model", provider: "provider-a", name: "Primary", api: "openai-responses" };
const SESSION = { id: "session-model", provider: "provider-b", name: "Session", api: "openai-responses" };
const VIRTUAL = { id: "auto", provider: "router", name: "Auto", api: "pi-virtual" };

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

// Models a router that never settles and ignores cancellation.
function deafStream() {
  const never = new Promise<never>(() => {});
  return {
    async *[Symbol.asyncIterator]() {
      await never;
    },
    async result() {
      return never;
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

function makeCtx(notes: Note[], sessionModel: any = SESSION, primaryModel: any = PRIMARY, authOk = true) {
  const authCalls: any[] = [];
  return {
    model: sessionModel,
    authCalls,
    modelRegistry: {
      find: () => primaryModel,
      getApiKeyAndHeaders: async (model: any) => {
        authCalls.push(model);
        return authOk ? { ok: true, apiKey: "k", headers: {} } : { ok: false, error: "no key for provider-a" };
      },
      getProviderAuth: async () => ({ auth: { baseUrl: "https://seat.example" } }),
      streamSimple: (model: any, input: any, opts: any) => streamImpl(model, input, opts),
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

describe("virtual models through the registry", () => {
  for (const operation of ["batch", "range"] as const) {
    const summarize = (config: any, ctx: any, options: any = {}) => operation === "batch"
      ? summarizeBatch(makeBatch(), config, ctx, options)
      : summarizeRange("- step one", config, ctx, options);

    it(`${operation}: virtual session model rescues a transient primary`, async () => {
      const seen: any[] = [];
      streamImpl = (model) => {
        seen.push(model);
        return model === PRIMARY ? errStream("down") : okStream("- routed summary");
      };
      const notes: Note[] = [];
      const controller = new FallbackController();
      const result = await summarize(distinctConfig, makeCtx(notes, VIRTUAL), { controller });
      expect(result?.summaryText).toBe("- routed summary");
      expect(controller.inFallback).toBe(true);
      expect(seen[1]).toBe(VIRTUAL);
      expect(notes[0]).toEqual({ msg: "pi-condense: summarizer model Primary failing (down), using session model Auto until it recovers", level: "warning" });
      expect(notes.filter(n => n.level === "warning")).toHaveLength(1);
      expect(notes.filter(n => n.level === "error")).toHaveLength(0);
    });

    for (const selection of ["default", "router/auto"]) {
      it(`${operation}: virtual ${selection} skips auth and sends only summarizer context`, async () => {
        const calls: any[] = [];
        streamImpl = (model, input, opts) => {
          calls.push({ model, input, opts });
          return okStream("- ok");
        };
        const notes: Note[] = [];
        const ctx = makeCtx(notes, VIRTUAL, VIRTUAL);
        const result = await summarize({ ...DEFAULT_CONFIG, summarizerModel: selection }, ctx);
        expect(result?.summaryText).toBe("- ok");
        expect(calls).toHaveLength(1);
        expect(calls[0].model).toBe(VIRTUAL);
        expect(ctx.authCalls).toHaveLength(0);
        expect(Object.keys(calls[0].input)).toEqual(["messages"]);
        expect(calls[0].input.messages).toHaveLength(1);
        expect(calls[0].input.messages[0].role).toBe("user");
        expect(calls[0].opts.apiKey).toBeUndefined();
        expect(calls[0].opts.headers).toBeUndefined();
        expect(notes).toHaveLength(0);
      });
    }
  }

  it("passes the physical model unchanged and pre-checks once", async () => {
    const seen: any[] = [];
    streamImpl = (model) => {
      seen.push(model);
      return okStream("- ok");
    };
    const ctx = makeCtx([]);
    await summarizeBatch(makeBatch(), DEFAULT_CONFIG, ctx);
    expect(seen[0]).toBe(SESSION);
    expect(seen[0].baseUrl).toBeUndefined();
    expect(ctx.authCalls).toEqual([SESSION]);
  });

  it("missing physical credentials never stream or trip the controller", async () => {
    let called = 0;
    streamImpl = () => { called++; return okStream("- never"); };
    const notes: Note[] = [];
    const controller = new FallbackController();
    const result = await summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes, SESSION, PRIMARY, false), { controller });
    expect(result).toBeNull();
    expect(called).toBe(0);
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].msg).toContain("no key for provider-a");
  });

  it("virtual stream failure returns null with the existing error notice", async () => {
    streamImpl = () => errStream("router: no credentials for routed model");
    const notes: Note[] = [];
    const result = await summarizeBatch(makeBatch(), DEFAULT_CONFIG, makeCtx(notes, VIRTUAL));
    expect(result).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].msg).toContain("router: no credentials for routed model");
  });
});

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
    expect(notes[0].msg).toBe("pi-condense: summarizer model Primary failing, using session model Session until it recovers");
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
  for (const [kind, idleMs, maxMs, message] of [
    // Millisecond-scale overrides exercise timer behavior, not the default.
    ["idle", 20, 0, /stalled/],
    ["ceiling", 0, 20, /ceiling/],
  ] as const) {
    it(`stream that ignores the signal still times out (${kind})`, async () => {
      streamImpl = () => deafStream();
      const notes: Note[] = [];
      const ctx = makeCtx(notes, VIRTUAL);
      const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: idleMs, summarizerMaxTimeoutMs: maxMs };
      expect(await summarizeBatch(makeBatch(), cfg, ctx, {})).toBeNull();
      expect(notes).toHaveLength(1);
      expect(notes[0].level).toBe("warning");
      expect(notes[0].msg).toMatch(message);
    });
  }

  it("caller abort during a stream that ignores the signal throws, no warning", async () => {
    streamImpl = () => deafStream();
    const notes: Note[] = [];
    const ctx = makeCtx(notes, VIRTUAL);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 0 };
    await expect(summarizeBatch(makeBatch(), cfg, ctx, { signal: ac.signal })).rejects.toThrow();
    expect(notes).toHaveLength(0);
  });

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
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
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

async function withTimerClock(
  run: (clock: { advance(ms: number): Promise<void>; now(): number }) => Promise<void>,
) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { at: number; fire(): void }>();
  let now = 0;
  let nextId = 0;
  const drain = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = ++nextId;
    timers.set(id, { at: now + Number(delay), fire: () => callback(...args) });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: any) => { timers.delete(Number(id)); }) as unknown as typeof globalThis.clearTimeout;
  try {
    await run({
      now: () => now,
      async advance(ms) {
        await drain();
        const end = now + ms;
        while (true) {
          const next = [...timers.entries()]
            .filter(([, timer]) => timer.at <= end)
            .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
          if (!next) break;
          now = next[1].at;
          timers.delete(next[0]);
          next[1].fire();
          await drain();
        }
        now = end;
        await drain();
      },
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    timers.clear();
  }
}

const genericEnter = "pi-condense: summarizer model Primary failing, using session model Session until it recovers";

describe("immediate fallback reasons", () => {
  it("marks only the 45s preset as default", () => {
    expect(DEFAULT_CONFIG.summarizerIdleTimeoutMs).toBe(45000);
    expect(SUMMARIZER_IDLE_TIMEOUT_PRESETS.filter(p => p.label.includes("(default)")))
      .toEqual([{ value: "45000", label: "45s (default)" }]);
  });

  for (const raw of [
    { summarizerModel: "provider-a/primary-model" },
    { summarizerModel: "provider-a/primary-model", summarizerIdleTimeoutMs: 20000 },
  ]) {
    it(`delayed first event with ${raw.summarizerIdleTimeoutMs ?? "resolved default"}`, async () => {
      await withTimerClock(async clock => {
        const config = { ...DEFAULT_CONFIG, ...raw };
        const notes: Note[] = [];
        const attempts: any[] = [];
        let primarySignal: AbortSignal;
        streamImpl = (model, _input, opts) => {
          attempts.push(model);
          if (model === PRIMARY) {
            primarySignal = opts.signal;
            return drippingStream(opts, "- primary summary", 1, 25000);
          }
          return okStream("- rescued");
        };
        const controller = new FallbackController(clock.now);
        let settled = false;
        const pending = summarizeBatch(makeBatch(), config, makeCtx(notes), { controller });
        void pending.then(() => { settled = true; });
        await clock.advance(19999);
        expect(settled).toBe(false);
        await clock.advance(1);
        if (raw.summarizerIdleTimeoutMs === 20000) {
          expect(primarySignal!.aborted).toBe(true);
          expect((await pending)?.summaryText).toBe("- rescued");
          expect(attempts).toEqual([PRIMARY, SESSION]);
          expect(notes).toEqual([{ msg: genericEnter.replace("failing,", "failing (stalled (no output for 20s)),"), level: "warning" }]);
        } else {
          expect(config.summarizerIdleTimeoutMs).toBe(45000);
          expect(settled).toBe(false);
          expect(primarySignal!.aborted).toBe(false);
          await clock.advance(5000);
          expect((await pending)?.summaryText).toBe("- primary summary");
          expect(attempts).toEqual([PRIMARY]);
          expect(controller.inFallback).toBe(false);
          expect(notes).toEqual([]);
        }
      });
    });
  }

  for (const kind of ["idle", "ceiling"] as const) {
    it(`${kind} rescue carries the prefix-free reason`, async () => {
      await withTimerClock(async clock => {
        const notes: Note[] = [];
        streamImpl = (model, _input, opts) => {
          if (model === SESSION) return okStream("- rescued");
          if (kind === "ceiling") return hangingStream(opts);
          const drip = drippingStream(opts, "- partial", 1, 1000);
          const hang = hangingStream(opts);
          return {
            async *[Symbol.asyncIterator]() { yield* drip; yield* hang; },
            result: () => hang.result(),
          };
        };
        let settled = false;
        const pending = summarizeBatch(makeBatch(), {
          ...distinctConfig, summarizerIdleTimeoutMs: kind === "idle" ? 45000 : 0,
          summarizerMaxTimeoutMs: 180000,
        }, makeCtx(notes), { controller: new FallbackController(clock.now) });
        void pending.then(() => { settled = true; });
        await clock.advance(kind === "idle" ? 45000 : 179999);
        expect(settled).toBe(false);
        await clock.advance(kind === "idle" ? 1000 : 1);
        expect((await pending)?.summaryText).toBe("- rescued");
        const reason = kind === "idle" ? "stalled (no output for 45s)" : "exceeded 180s ceiling";
        expect(notes).toEqual([{ msg: genericEnter.replace("failing,", `failing (${reason}),`), level: "warning" }]);
        if (kind === "idle") expect(notes[0].msg).toMatch(/summarizer model .* failing \(stalled \(no output for \d+s\)\), using session model/);
      });
    });
  }

  for (const path of ["response", "throw"] as const) {
    for (const [name, message] of [
      ["non-empty", "boom"],
      ["multiline", "  long provider message\n" + "detail ".repeat(60) + "\n  "],
      ["empty", ""],
    ]) {
      it(`${path} preserves ${name} message verbatim`, async () => {
        streamImpl = model => {
          if (model === SESSION) return okStream("- rescued");
          if (path === "throw") throw new Error(message);
          return errStream(message);
        };
        const notes: Note[] = [];
        const result = await summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes), { controller: new FallbackController() });
        expect(result?.summaryText).toBe("- rescued");
        expect(notes).toEqual([{ msg: message ? genericEnter.replace("failing,", `failing (${message}),`) : genericEnter, level: "warning" }]);
      });
    }
  }
});

describe("terminal timeout labels", () => {
  for (const kind of ["idle", "ceiling"] as const) {
    for (const mode of ["legacy", "fallback-only", "both-down", "unusable-retry"] as const) {
      it(`${kind}: ${mode} labels the selected outcome`, async () => {
        await withTimerClock(async clock => {
          const notes: Note[] = [];
          streamImpl = (model, _input, opts) => mode === "unusable-retry" && model === SESSION
            ? okStream(" ") : hangingStream(opts);
          const controller = new FallbackController(clock.now);
          if (mode === "fallback-only") controller.onBothDown();
          const pending = summarizeBatch(makeBatch(), {
            ...distinctConfig,
            summarizerModel: mode === "legacy" ? "default" : distinctConfig.summarizerModel,
            summarizerIdleTimeoutMs: kind === "idle" ? 20 : 0,
            summarizerMaxTimeoutMs: kind === "ceiling" ? 20 : 0,
          }, makeCtx(notes), mode === "legacy" ? {} : { controller });
          await clock.advance(40);
          expect(await pending).toBeNull();
          const label = mode === "unusable-retry" ? "Primary" : "Session";
          const reason = kind === "idle" ? "stalled (no output for 0s)" : "exceeded 0s ceiling";
          expect(notes).toEqual([{ msg: `pi-condense: summarizer ${label} ${reason}; summarizer call abandoned`, level: "warning" }]);
        });
      });
    }
  }

  it("session-only auth failure after transient primary keeps its error text", async () => {
    streamImpl = () => errStream("down");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    ctx.modelRegistry.getApiKeyAndHeaders = async (model: any) => model === PRIMARY
      ? { ok: true, apiKey: "k", headers: {} } : { ok: false, error: "session key missing" };
    expect(await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller: new FallbackController() })).toBeNull();
    expect(notes).toEqual([{ msg: "pruner: summarization failed: session key missing", level: "error" }]);
  });
});

describe("deferred entry and probe notices", () => {
  for (const initial of ["both-down", "rescued"] as const) {
    it(`${initial}: failed probe rescue then recovery`, async () => {
      let now = 0;
      const controller = new FallbackController(() => now);
      const notes: Note[] = [];
      const ctx = makeCtx(notes);
      streamImpl = model => model === PRIMARY || initial === "both-down" ? errStream("down") : okStream("- ok");
      await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
      notes.length = 0;
      now += 600001;
      streamImpl = model => model === PRIMARY ? errStream("probe failed") : okStream("- rescued");
      expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }))?.summaryText).toBe("- rescued");
      expect(notes).toEqual(initial === "both-down" ? [{ msg: genericEnter, level: "warning" }] : []);
      notes.length = 0;
      now += 600001;
      streamImpl = () => okStream("- recovered");
      await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
      expect(notes).toEqual([{ msg: "pi-condense: summarizer model Primary recovered", level: "info" }]);
    });
  }

  it("blank primary never retries or enters fallback", async () => {
    const attempts: any[] = [];
    streamImpl = model => { attempts.push(model); return okStream(" "); };
    const controller = new FallbackController();
    const notes: Note[] = [];
    expect(await summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes), { controller })).toBeNull();
    expect(attempts).toEqual([PRIMARY]);
    expect(controller.inFallback).toBe(false);
    expect(notes).toEqual([]);
  });

  it("abort during pending stream rejects without notices", async () => {
    await withTimerClock(async clock => {
      streamImpl = (_model, _input, opts) => hangingStream(opts);
      const notes: Note[] = [];
      const ac = new AbortController();
      const pending = summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes), { controller: new FallbackController(clock.now), signal: ac.signal });
      const rejected = pending.then(() => null, error => error);
      await clock.advance(1);
      ac.abort();
      expect(await rejected).toBeInstanceOf(Error);
      expect(notes).toEqual([]);
    });
  });
});
