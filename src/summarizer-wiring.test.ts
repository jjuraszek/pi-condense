import { describe, it, expect, mock } from "bun:test";

// Stub pi-ai's `stream` so runSummarization can be exercised without a network
// call. `streamImpl` is swapped per test to simulate primary/fallback outcomes.
let streamImpl: (model: any) => any = () => {
  throw new Error("streamImpl not set");
};
mock.module("@earendil-works/pi-ai", () => ({
  stream: (model: any) => streamImpl(model),
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
