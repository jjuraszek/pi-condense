import { describe, it, expect } from "bun:test";
import { FallbackController, COOLDOWN_MS } from "./summarizer-fallback.js";

const HAIKU = { id: "claude-haiku", provider: "anthropic", name: "Haiku" };
const SONNET = { id: "claude-sonnet", provider: "anthropic", name: "Sonnet" };

function clockAt(t: { now: number }) {
  return () => t.now;
}

describe("hasDistinctFallback", () => {
  it("false when models are identical", () => {
    expect(FallbackController.hasDistinctFallback(HAIKU, HAIKU)).toBe(false);
  });
  it("false when either model is missing", () => {
    expect(FallbackController.hasDistinctFallback(undefined, SONNET)).toBe(false);
    expect(FallbackController.hasDistinctFallback(HAIKU, undefined)).toBe(false);
  });
  it("true when id or provider differ", () => {
    expect(FallbackController.hasDistinctFallback(HAIKU, SONNET)).toBe(true);
    expect(
      FallbackController.hasDistinctFallback(
        { id: "m", provider: "a" },
        { id: "m", provider: "b" },
      ),
    ).toBe(true);
  });
});

describe("chooseTarget", () => {
  it("targets primary when not in fallback", () => {
    const c = new FallbackController();
    expect(c.chooseTarget()).toEqual({ target: "primary", wasProbe: false });
  });

  it("targets fallback while in fallback and before cooldown", () => {
    const t = { now: 1_000_000 };
    const c = new FallbackController(clockAt(t));
    c.onPrimaryFailFallbackOk(false);
    expect(c.inFallback).toBe(true);
    t.now += COOLDOWN_MS - 1;
    expect(c.chooseTarget()).toEqual({ target: "fallback", wasProbe: false });
  });

  it("elects exactly one probe after cooldown elapses", () => {
    const t = { now: 0 };
    const c = new FallbackController(clockAt(t));
    c.onPrimaryFailFallbackOk(false); // enter, lastProbeAt = 0
    t.now = COOLDOWN_MS;
    expect(c.chooseTarget()).toEqual({ target: "primary", wasProbe: true });
    expect(c.chooseTarget()).toEqual({ target: "fallback", wasProbe: false });
  });
});

describe("enter fallback (single notify across N)", () => {
  it("first rescued transient returns 'enter', rest return 'none'", () => {
    const c = new FallbackController();
    expect(c.onPrimaryFailFallbackOk(false)).toBe("enter");
    expect(c.inFallback).toBe(true);
    expect(c.onPrimaryFailFallbackOk(false)).toBe("none");
    expect(c.onPrimaryFailFallbackOk(false)).toBe("none");
  });
});

describe("recover", () => {
  it("probe success while in fallback returns 'recover' and clears state", () => {
    const c = new FallbackController();
    c.onPrimaryFailFallbackOk(false); // enter
    expect(c.onPrimarySuccess(true)).toBe("recover");
    expect(c.inFallback).toBe(false);
  });
  it("non-probe primary success is a no-op", () => {
    const c = new FallbackController();
    expect(c.onPrimarySuccess(false)).toBe("none");
    expect(c.inFallback).toBe(false);
  });
});

describe("probe transient failure keeps fallback (stay)", () => {
  it("rescued probe returns 'none' and stays in fallback", () => {
    const t = { now: 0 };
    const c = new FallbackController(clockAt(t));
    c.onPrimaryFailFallbackOk(false); // enter
    t.now = COOLDOWN_MS;
    const d = c.chooseTarget(); // claims probe
    expect(d.wasProbe).toBe(true);
    t.now = COOLDOWN_MS + 5;
    expect(c.onPrimaryFailFallbackOk(true)).toBe("none");
    expect(c.inFallback).toBe(true);
  });
});

describe("both-down owes a deferred enter warning", () => {
  it("owed warning fires on the first later fallback success", () => {
    const c = new FallbackController();
    c.onBothDown(); // initial detection both-down: enter silently, owe warning
    expect(c.inFallback).toBe(true);
    expect(c.onFallbackSuccess()).toBe("enter");
    expect(c.onFallbackSuccess()).toBe("none");
  });
  it("both-down while already in fallback does not owe a new warning", () => {
    const c = new FallbackController();
    c.onPrimaryFailFallbackOk(false); // enter (warning already shown)
    c.onBothDown(); // probe both-down while in fallback
    expect(c.onFallbackSuccess()).toBe("none");
  });
});

describe("recover clears an owed enter warning", () => {
  it("a probe recovery after both-down does not later emit a stale enter", () => {
    const t = { now: 0 };
    const c = new FallbackController(clockAt(t));
    c.onBothDown(); // enter silently, owe warning
    t.now = COOLDOWN_MS;
    const d = c.chooseTarget(); // claims probe
    expect(d.wasProbe).toBe(true);
    expect(c.onPrimarySuccess(true)).toBe("recover");
    expect(c.inFallback).toBe(false);
    // owed warning must be cleared by recovery
    expect(c.onFallbackSuccess()).toBe("none");
  });
});

describe("unusable probe does not falsely recover", () => {
  it("no onPrimarySuccess call means inFallback is retained", () => {
    const t = { now: 0 };
    const c = new FallbackController(clockAt(t));
    c.onPrimaryFailFallbackOk(false); // enter
    t.now = COOLDOWN_MS;
    const d = c.chooseTarget();
    expect(d.wasProbe).toBe(true);
    expect(c.inFallback).toBe(true);
  });
});

describe("reset", () => {
  it("clears all state", () => {
    const t = { now: 5 };
    const c = new FallbackController(clockAt(t));
    c.onBothDown();
    c.reset();
    expect(c.inFallback).toBe(false);
    expect(c.onFallbackSuccess()).toBe("none"); // owed cleared
    expect(c.chooseTarget()).toEqual({ target: "primary", wasProbe: false });
  });
});
