import { describe, expect, spyOn, test } from "bun:test";
import { DiagnosticSink } from "./diagnostics.js";
import { CUSTOM_TYPE_DIAGNOSTIC } from "./types.js";

const sinkWithLog = () => {
  const appended: Array<{ type: string; data: any }> = [];
  const sink = new DiagnosticSink((type, data) => appended.push({ type, data }));
  return { sink, appended };
};

describe("DiagnosticSink", () => {
  test("writes one session entry per distinct (kind, dedupKey)", () => {
    const { sink, appended } = sinkWithLog();
    sink.report("unresolved-range", "b5", "blockId=b5 start=1000 final=null");
    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe(CUSTOM_TYPE_DIAGNOSTIC);
    expect(appended[0].data).toEqual({ kind: "unresolved-range", detail: "blockId=b5 start=1000 final=null" });
  });

  test("dedupes a repeated (kind, dedupKey) within the session", () => {
    const { sink, appended } = sinkWithLog();
    sink.report("unresolved-range", "b5", "first");
    sink.report("unresolved-range", "b5", "second");
    expect(appended).toHaveLength(1);
    expect(sink.counts()["unresolved-range"]).toBe(1);
  });

  test("a different dedupKey of the same kind still reports", () => {
    const { sink, appended } = sinkWithLog();
    sink.report("unresolved-range", "b5", "x");
    sink.report("unresolved-range", "b7", "y");
    expect(appended).toHaveLength(2);
    expect(sink.counts()["unresolved-range"]).toBe(2);
  });

  test("the same dedupKey under two different kinds both report", () => {
    const { sink, appended } = sinkWithLog();
    sink.report("unresolved-range", "b5", "x");
    sink.report("range-id-mismatch", "b5", "y");
    expect(appended).toHaveLength(2);
    expect(appended[0].type).toBe(CUSTOM_TYPE_DIAGNOSTIC);
    expect(appended[1].type).toBe(CUSTOM_TYPE_DIAGNOSTIC);
    expect(sink.counts()["unresolved-range"]).toBe(1);
    expect(sink.counts()["range-id-mismatch"]).toBe(1);
  });

  test("counts are per kind and start at zero", () => {
    const { sink } = sinkWithLog();
    expect(sink.counts()).toEqual({ "unresolved-range": 0, "range-id-mismatch": 0, "orphan-sweep": 0, "backfill-empty": 0 });
    sink.report("orphan-sweep", "a,b", "swept 2");
    expect(sink.counts()["orphan-sweep"]).toBe(1);
  });

  test("an appendEntry failure never throws into the render path, and does not mark the key as seen", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const sink = new DiagnosticSink(() => {
      throw new Error("session closed");
    });
    expect(() => sink.report("orphan-sweep", "a", "detail")).not.toThrow();
    expect(spy).toHaveBeenCalled();
    expect(sink.counts()["orphan-sweep"]).toBe(0);
    spy.mockRestore();
  });

  test("a retry of the same (kind, dedupKey) after appendEntry starts working persists and counts", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let working = false;
    const appended: Array<{ type: string; data: any }> = [];
    const sink = new DiagnosticSink((type, data) => {
      if (!working) throw new Error("session closed");
      appended.push({ type, data });
    });

    expect(() => sink.report("orphan-sweep", "a", "detail")).not.toThrow();
    expect(sink.counts()["orphan-sweep"]).toBe(0);
    expect(appended).toHaveLength(0);

    working = true;
    sink.report("orphan-sweep", "a", "detail");
    expect(sink.counts()["orphan-sweep"]).toBe(1);
    expect(appended).toHaveLength(1);

    spy.mockRestore();
  });

  test("counts() returns a snapshot; mutating it does not affect internal counters", () => {
    const { sink } = sinkWithLog();
    sink.report("orphan-sweep", "a", "detail");
    const snapshot = sink.counts();
    snapshot["orphan-sweep"] = 999;
    expect(sink.counts()["orphan-sweep"]).toBe(1);
  });

  test("reset() zeroes all counters", () => {
    const { sink } = sinkWithLog();
    sink.report("unresolved-range", "b5", "x");
    sink.report("orphan-sweep", "a", "y");
    sink.reset();
    expect(sink.counts()).toEqual({ "unresolved-range": 0, "range-id-mismatch": 0, "orphan-sweep": 0, "backfill-empty": 0 });
  });

  test("reset() allows a previously-seen (kind, dedupKey) to report again", () => {
    const { sink, appended } = sinkWithLog();
    sink.report("unresolved-range", "b5", "first");
    expect(appended).toHaveLength(1);

    sink.reset();

    sink.report("unresolved-range", "b5", "second");
    expect(appended).toHaveLength(2);
    expect(appended[1].data).toEqual({ kind: "unresolved-range", detail: "second" });
    expect(sink.counts()["unresolved-range"]).toBe(1);
  });
});

test("counts backfill-empty like any other kind", () => {
  const appended: Array<{ type: string; data: any }> = [];
  const sink = new DiagnosticSink((type, data) => appended.push({ type, data }));
  sink.report("backfill-empty", "b5", "middleCount=0");
  sink.report("backfill-empty", "b5", "middleCount=0"); // deduped
  expect(sink.counts()["backfill-empty"]).toBe(1);
  expect(appended.length).toBe(1);
});
