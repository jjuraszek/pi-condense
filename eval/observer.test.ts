import { describe, expect, test } from "bun:test";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { observe, classifySummarizer, sumMeasurements } from "./observer.js";

const model = { provider: "anthropic", id: "summary", api: "anthropic-messages", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
const usage = { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.1 } };
const message = (extra = {}) => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0, usage, ...extra });
const context = () => ({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
const evidence = { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 2 } } };

describe("observe", () => {
  test("stream iteration and result remain original; snapshots phase/context and binds private methods", async () => {
    const stream = new AssistantMessageEventStream();
    class Runtime {
      #value = 7;
      other() { return this.#value; }
      streamSimple(_m: any, _c: any, options: any) { options.onProviderStreamEvent(evidence, model); return stream; }
      async completeSimple() { return message(); }
    }
    const observed = observe(new Runtime());
    observed.setPhase("summarizer");
    const ctx = context();
    let callbacks = 0;
    const result = observed.runtime.streamSimple(model, ctx, { apiKey: "SECRET", onProviderStreamEvent: () => { callbacks++; } });
    expect(result).toBe(stream);
    ctx.messages[0].content = "changed";
    observed.setPhase("subject");
    const answer = message();
    stream.push({ type: "done", reason: "stop", message: answer } as any);
    const events = [];
    for await (const event of result) events.push(event);
    expect(await result.result()).toBe(answer);
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(callbacks).toBe(1);
    expect(observed.runtime.other()).toBe(7);
    expect(observed.records).toHaveLength(1);
    const record = observed.records[0];
    expect(record.phase).toBe("summarizer");
    expect(record.context.messages[0].content).toBe("synthetic");
    expect(record.usage).toBe(usage);
    expect(record.measurements.input).toEqual({ value: 0, provenance: "measured" });
    expect(record.measurements.cacheRead.provenance).toBe("unavailable");
    expect(record.measurements.cost).toEqual({ value: 0.1, provenance: "estimated" });
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toContain("SECRET");
  });

  test.each(["sync", "reject", "error", "aborted"])("records %s once without exposing raw errors", async (kind) => {
    const error = Object.assign(new Error("SECRET headers"), { status: 429 });
    const answer = message({ stopReason: kind, errorMessage: "SECRET provider body" });
    const runtime = {
      streamSimple() { if (kind === "sync") throw error; const s = new AssistantMessageEventStream(); s.end(answer as any); return s; },
      completeSimple() { if (kind === "sync") throw error; if (kind === "reject") return Promise.reject(error); return Promise.resolve(answer); },
    };
    const observed = observe(runtime);
    if (kind === "sync" || kind === "reject") {
      try { await observed.runtime.completeSimple(model, context()); throw new Error("did not reject"); } catch (caught) { expect(caught).toBe(error); }
    } else expect(await observed.runtime.completeSimple(model, context())).toBe(answer);
    expect(observed.records).toHaveLength(1);
    expect(observed.records[0].status).toBe(`error:${kind === "error" || kind === "aborted" ? kind : "http"}`);
    expect(JSON.stringify(observed.records)).not.toContain("SECRET");
    if (kind === "sync") {
      expect(() => observed.runtime.streamSimple(model, context())).toThrow(error);
      expect(observed.records).toHaveLength(2);
    }
  });

  test("stream result rejection is observed without replacing stream or error; transport metadata is safe", async () => {
    const error = Object.assign(new Error("SECRET request URL"), { code: "ECONNRESET" });
    const result = Promise.reject(error);
    const stream = { result: () => result };
    const observed = observe({ streamSimple: () => stream, completeSimple: () => result });
    expect(observed.runtime.streamSimple(model, context())).toBe(stream);
    try { await stream.result(); } catch (caught) { expect(caught).toBe(error); }
    await Promise.resolve();
    expect(observed.records).toHaveLength(1);
    expect(observed.records[0].retry).toEqual({ kind: "transport", retryable: true });
    expect(JSON.stringify(observed.records)).not.toContain("SECRET");
  });

  test("Anthropic delta evidence and terminal stream errors preserve the final message", async () => {
    const stream = new AssistantMessageEventStream();
    const observed = observe({ streamSimple(_m: any, _c: any, options: any) {
      options.onProviderStreamEvent({ type: "message_delta", usage: { output_tokens: 0 } }, model);
      return stream;
    }, completeSimple() { throw new Error(); } });
    const answer = message({ stopReason: "aborted", usage: { ...usage, output: 0 } });
    const returned = observed.runtime.streamSimple(model, context());
    stream.push({ type: "error", reason: "aborted", error: answer } as any);
    expect(await returned.result()).toBe(answer);
    await Promise.resolve();
    expect(observed.records[0].status).toBe("error:aborted");
    expect(observed.records[0].measurements.output).toEqual({ value: 0, provenance: "measured" });
    expect(observed.records[0].measurements.input.provenance).toBe("unavailable");
  });

  test.each([
    ["missing usage", undefined, model, false, "unavailable"],
    ["missing cost", { input: 0 }, model, true, "unavailable"],
    ["priced Copilot", usage, { ...model, provider: "github-copilot" }, true, "estimated"],
    ["unpriced", usage, { ...model, cost: { input: 0, output: 0 } }, true, "unavailable"],
    ["unknown adapter", usage, { ...model, api: "unknown" }, true, "unavailable"],
    ["no evidence", usage, model, false, "estimated"],
    ["negative finite cost", { ...usage, cost: { total: -0.1 } }, model, true, "estimated"],
    ...[NaN, Infinity, -Infinity].map(total => [`non-finite cost ${total}`, { ...usage, cost: { total } }, model, true, "unavailable"]),
  ])("%s preserves missing measurements", async (_name, raw, requested, emit, costProvenance) => {
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple(_m: any, _c: any, options: any) { if (emit) await options.onProviderStreamEvent(evidence, requested); return message({ usage: raw }); } });
    await observed.runtime.completeSimple(requested, context());
    const record = observed.records[0];
    expect(record.usage).toBe(raw);
    expect(record.measurements.cost.provenance).toBe(costProvenance);
    expect(record.measurements.input.provenance).toBe(emit && raw && requested.api === model.api ? "measured" : "unavailable");
  });

  test("Responses terminal usage supports explicit zeros and propagates missingness in sums", async () => {
    const requested = { ...model, api: "openai-responses" };
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple(_m: any, _c: any, options: any) {
      await options.onProviderStreamEvent({ type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } }, requested);
      return message({ usage: { ...usage, output: 0, totalTokens: 0 } });
    } });
    await observed.runtime.completeSimple(requested, context());
    const m = observed.records[0].measurements;
    expect(m.output).toEqual({ value: 0, provenance: "measured" });
    expect(m.cost).toEqual({ value: 0.1, provenance: "estimated" });
    expect(sumMeasurements([m, m]).input.value).toBe(0);
    expect(sumMeasurements([m, { ...m, input: { provenance: "unavailable" } }]).input.provenance).toBe("unavailable");
  });

  test.each([
    ["chunk", { usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]],
    ["first choice", { choices: [{ usage: { completion_tokens: 0 } }] }, ["output"]],
    ["DeepSeek cache", { usage: { prompt_cache_hit_tokens: 0 } }, ["cacheRead"]],
    ["Kimi cache", { usage: { cached_tokens: 0 } }, ["cacheRead"]],
    ["chunk takes precedence", { usage: { completion_tokens: 0 }, choices: [{ usage: { prompt_tokens: 0 } }] }, ["output"]],
    ["absent fields", { usage: {} }, []],
    ["absent usage", { choices: [] }, []],
  ])("Completions %s preserves provider availability despite normalized zeros", async (_name, event, available) => {
    const requested = { ...model, api: "openai-completions" };
    const answer = message({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple(_m: any, _c: any, options: any) {
      await options.onProviderStreamEvent(event, requested);
      return answer;
    } });
    expect(await observed.runtime.completeSimple(requested, context())).toBe(answer);
    expect(observed.records).toHaveLength(1);
    const measurements = observed.records[0].measurements;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      expect(measurements[field]).toEqual(available.includes(field) ? { value: 0, provenance: "measured" } : { provenance: "unavailable" });
    }
    expect(measurements.cost).toEqual({ value: 0, provenance: "estimated" });
  });

  test.each([
    ["chunk replacement", { usage: { completion_tokens: 4 } }, 0, 4, 4, ["output"]],
    ["first-choice replacement", { choices: [{ usage: { completion_tokens: 4 } }] }, 0, 4, 4, ["output"]],
    ["empty replacement", { usage: {} }, 0, 0, 0, []],
    ["no usage", { choices: [] }, 12, 3, 15, ["input", "output", "totalTokens"]],
  ] as const)("Completions %s tracks final usage availability", async (_name, event, input, output, totalTokens, available) => {
    const requested = { ...model, api: "openai-completions" };
    const answer = message({ usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: 0 } } });
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple(_m: any, _c: any, options: any) {
      await options.onProviderStreamEvent({ usage: { prompt_tokens: 12, completion_tokens: 3 } }, requested);
      await options.onProviderStreamEvent(event, requested);
      return answer;
    } });
    expect(await observed.runtime.completeSimple(requested, context())).toBe(answer);
    expect(observed.records[0].usage).toBe(answer.usage);
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      expect(observed.records[0].measurements[field]).toEqual((available as readonly string[]).includes(field)
        ? { value: answer.usage[field], provenance: "measured" }
        : { provenance: "unavailable" });
    }
  });

  test.each(["streamSimple", "completeSimple"] as const)("%s estimates finite cost without token evidence on every known API", async method => {
    for (const [api, total] of [["anthropic-messages", -0.1], ["openai-responses", 0], ["openai-completions", 0.1]] as const) {
      const answer = message({ usage: { cost: { total } } });
      const stream = { result: () => Promise.resolve(answer) };
      const observed = observe({ streamSimple: () => stream, completeSimple: async () => answer });
      const result = observed.runtime[method]({ ...model, api }, context());
      if (method === "streamSimple") {
        expect(result).toBe(stream);
        expect(await (result as typeof stream).result()).toBe(answer);
      } else expect(await result).toBe(answer);
      await Promise.resolve();
      expect(observed.records).toHaveLength(1);
      const measurements = observed.records[0].measurements;
      expect(measurements.cost).toEqual({ value: total, provenance: "estimated" });
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
        expect(measurements[field]).toEqual({ provenance: "unavailable" });
      }
    }
  });

  test("fallback wins over terminal errors and missing flush; requested and response identities checked", async () => {
    for (const [requested, extra] of [[model, { responseModel: "subject" }], [{ ...model, id: "subject" }, {}]] as const) {
      const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple() { return message({ ...extra, stopReason: "error" }); } });
      observed.setPhase("summarizer");
      await observed.runtime.completeSimple(requested, context());
      expect(classifySummarizer(observed.records, model, false)).toBe("error:summarizer-fallback");
    }
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple() { return message({ stopReason: "aborted" }); } });
    observed.setPhase("summarizer");
    await observed.runtime.completeSimple(model, context());
    expect(classifySummarizer(observed.records, model, false)).toBe("error:summarizer");
    expect(classifySummarizer([], model, false)).toBe("error:no-flush");
  });
});
