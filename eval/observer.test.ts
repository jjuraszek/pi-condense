import { describe, expect, test } from "bun:test";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { retryJob } from "./run";
import { observe, classifySummarizer, sumMeasurements } from "./observer.js";

const model = { provider: "anthropic", id: "summary", api: "anthropic-messages", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
const usage = { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.1 } };
const message = (extra = {}) => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0, usage, ...extra });
const context = () => ({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
const evidence = { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 2 } } };

describe("observe", () => {
  test.each(["streamSimple", "completeSimple"] as const)("%s records only judge text and stop reason", async method => {
    const answer = message({ content: [{ type: "text", text: "```json\n" }, { type: "thinking", thinking: "SECRET thinking", thinkingSignature: "SECRET signature" }, { type: "text", text: "{}\n```" }], errorMessage: "SECRET provider error" });
    const stream = { result: () => Promise.resolve(answer) };
    const observed = observe({ streamSimple: () => stream, completeSimple: async () => answer });
    for (const phase of ["subject", "summarizer", "judge"] as const) {
      observed.setPhase(phase);
      const returned = observed.runtime[method](model, context(), { apiKey: "SECRET credential", headers: { authorization: "SECRET auth" } });
      observed.setPhase("subject");
      if (method === "streamSimple") {
        expect(returned).toBe(stream);
        expect(await (returned as typeof stream).result()).toBe(answer);
      } else expect(await returned).toBe(answer);
      await Promise.resolve();
      const record = observed.records.at(-1)!;
      expect(record.judgeResponse).toEqual(phase === "judge" ? { text: "```json\n{}\n```", stopReason: "stop" } : undefined);
    }
    expect(JSON.stringify(observed.records)).not.toContain("SECRET");
    expect(JSON.stringify(observed.records)).not.toContain("apiKey");
    expect(JSON.stringify(observed.records)).not.toContain("authorization");
  });
  test.each(["google-generative-ai", "google-vertex", "unknown"])("%s preserves options and original stream/result without injected fetch", async api => {
    const answer = message({ api });
    const stream = { result: () => Promise.resolve(answer) };
    let expected: any;
    const check = (options: any) => {
      expect(options).toBe(expected);
      expect(options?.fetch).toBe(expected?.fetch);
    };
    const observed = observe({
      streamSimple(_m: any, _c: any, options: any) { check(options); return stream; },
      async completeSimple(_m: any, _c: any, options: any) { check(options); return answer; },
    });
    for (const options of [undefined, { apiKey: "synthetic" }, { fetch: globalThis.fetch }]) {
      expected = options;
      expect(observed.runtime.streamSimple({ ...model, api }, context(), options)).toBe(stream);
      expect(await stream.result()).toBe(answer);
      expect(await observed.runtime.completeSimple({ ...model, api }, context(), options)).toBe(answer);
    }
    expect(observed.records).toHaveLength(6);
  });
  test.each([429, 401, "transport", "transport-cause"] as const)("real adapter terminal %s reaches fresh-job retry policy offline", async kind => {
    const delays: number[] = [];
    const dirs: string[] = [];
    const result = await retryJob("offline", async dir => {
      dirs.push(dir);
      const observed = observe({ streamSimple, completeSimple: async (...args: any[]) => (streamSimple as any)(...args).result() });
      const answer = await observed.runtime.streamSimple({ ...model, name: "Offline", baseUrl: "https://invalid.invalid", input: ["text"], maxTokens: 100, contextWindow: 1000 } as any, context(), {
        apiKey: "synthetic-offline", maxRetries: 0,
        fetch: async () => {
          if (kind === "transport") throw Object.assign(new Error("SECRET transport"), { code: "ECONNRESET" });
          if (kind === "transport-cause") throw new TypeError("SECRET transport", { cause: Object.assign(new Error("SECRET cause"), { code: "ECONNRESET" }) });
          return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "SECRET provider body" } }), { status: kind });
        },
      }).result();
      expect(answer.stopReason).toBe("error");
      await Promise.resolve();
      expect(observed.records[0].retry).toEqual(typeof kind === "string" ? { kind: "transport", retryable: true } : { kind: "http", httpStatus: kind, retryable: kind === 429 });
      expect(JSON.stringify(observed.records)).not.toContain("SECRET");
      expect(JSON.stringify(observed.records)).not.toContain("synthetic-offline");
      return { status: "error", errorReason: "error:subject", records: observed.records, elapsedMs: { total: 1 } };
    }, async ms => { delays.push(ms); });
    expect(delays).toEqual(kind === 401 ? [] : [2000, 8000]);
    expect(new Set(dirs).size).toBe(kind === 401 ? 1 : 3);
    expect(result.attempts).toBe(dirs.length);
  });

  test.each([
    ["anthropic-messages", streamSimple, "streamSimple"],
    ["anthropic-messages", streamSimple, "completeSimple"],
    ["openai-responses", streamResponses, "streamSimple"],
    ["openai-responses", streamResponses, "completeSimple"],
    ["openai-completions", streamCompletions, "streamSimple"],
    ["openai-completions", streamCompletions, "completeSimple"],
  ] as const)("%s HTTP 200 body reset through %s retries fresh jobs offline", async (api, adapter, method) => {
    const delays: number[] = [];
    const dirs: string[] = [];
    const result = await retryJob("offline-body", async dir => {
      dirs.push(dir);
      const observed = observe({ streamSimple: adapter, completeSimple: async (...args: any[]) => (adapter as any)(...args).result() });
      const requested = { ...model, api, name: "Offline", baseUrl: "https://invalid.invalid", input: ["text"], maxTokens: 100, contextWindow: 1000 } as any;
      const pending = observed.runtime[method](requested, context(), {
        apiKey: "synthetic-offline", maxRetries: 0,
        fetch: async () => new Response(new ReadableStream({
          pull(controller) { controller.error(Object.assign(new Error("SECRET body"), { code: "ECONNRESET" })); },
        }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      });
      const answer = await (method === "streamSimple" ? (pending as any).result() : pending);
      expect(answer.stopReason).toBe("error");
      await Promise.resolve();
      expect(observed.records[0].status).toBe("error:transport");
      expect(observed.records[0].retry).toEqual({ kind: "transport", retryable: true });
      expect(JSON.stringify(observed.records)).not.toContain("SECRET");
      expect(JSON.stringify(observed.records)).not.toContain("synthetic-offline");
      return { status: "error", errorReason: "error:subject", records: observed.records, elapsedMs: { total: 1 } };
    }, async ms => { delays.push(ms); });
    expect(delays).toEqual([2000, 8000]);
    expect(new Set(dirs).size).toBe(3);
    expect(result.attempts).toBe(3);
  });

  test.each(["error", "cancel", "cancel-error"] as const)("body reader preserves %s and response identity", async operation => {
      const error = Object.assign(new Error("SECRET body"), { code: "ECONNRESET" });
      const reason = { cancel: true };
      const expectedCancelError = operation === "cancel-error" ? error : undefined;
      let pulls = 0;
      let cancelCalls = 0;
      let canceled: unknown;
      const body = new ReadableStream({
        pull(controller) { pulls++; if (operation === "error") controller.error(error); else controller.enqueue(new Uint8Array([1])); },
        cancel(value) { cancelCalls++; canceled = value; if (operation === "cancel-error") throw error; },
      }, { highWaterMark: 0 });
      const response = new Response(body);
      const observed = observe({ streamSimple() { throw Error(); }, async completeSimple(_m: any, _c: any, options: any) {
        expect(await options.fetch("https://invalid.invalid")).toBe(response);
        expect(response.body).toBe(body);
        expect(body.locked).toBe(false);
        expect(pulls).toBe(0);
        const consumer = body.getReader();
        if (operation === "error") {
          try { await consumer.read(); throw Error("did not reject"); }
          catch (caught) { expect(caught).toBe(error); }
        } else {
          await consumer.read();
          const cancel = consumer.cancel(reason);
          let cancelError: unknown;
          try { await cancel; } catch (caught) { cancelError = caught; }
          expect(cancelError).toBe(expectedCancelError);
          expect(cancelCalls).toBe(1);
          expect(canceled).toBe(reason);
        }
        consumer.releaseLock();
        expect(body.locked).toBe(false);
        return message({ stopReason: operation === "error" ? "error" : "aborted" });
      } });
      await observed.runtime.completeSimple(model, context(), { fetch: async () => response });
      expect(observed.records[0].retry).toEqual(operation === "error" ? { kind: "transport", retryable: true } : { retryable: false });
  });

  test("fetch results and errors remain original and eventual success clears retry evidence", async () => {
    const response = new Response("", { status: 429 });
    const error = Object.assign(new Error("SECRET"), { code: "ECONNRESET" });
    const observed = observe({ streamSimple() { throw Error(); }, async completeSimple(_m: any, _c: any, options: any) {
      expect(await options.fetch("https://invalid.invalid")).toBe(response);
      try { await options.fetch("https://invalid.invalid"); } catch (caught) { expect(caught).toBe(error); }
      return message();
    } });
    let calls = 0;
    const answer = await observed.runtime.completeSimple(model, context(), { fetch: async () => { if (calls++) throw error; return response; } });
    expect(answer.stopReason).toBe("stop");
    expect(observed.records[0].retry).toEqual({ retryable: false });
  });
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
    const observed = observe({ streamSimple() { throw new Error(); }, async completeSimple(_m: any, _c: any, options: any) { if (emit) await options?.onProviderStreamEvent?.(evidence, requested); return message({ usage: raw }); } });
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
