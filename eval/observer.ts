import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

export type Phase = "summarizer" | "subject" | "judge";
export type Identity = { provider: string; id: string };
export type Measurement = { value: number; provenance: "measured" | "estimated" } | { provenance: "unavailable"; value?: never };
const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
export type Measurements = Record<(typeof fields)[number], Measurement>;
export interface CallRecord {
  phase: Phase;
  requested: Identity;
  answered?: Identity;
  context: Context;
  status: "ok" | `error:${string}`;
  usage?: AssistantMessage["usage"];
  elapsedMs: number;
  measurements: Measurements;
  retry: { retryable: boolean; kind?: "http" | "transport"; httpStatus?: number };
}
// Only the two public invocation boundaries are intercepted. Other methods keep their receiver.
type Runtime = { streamSimple: (...args: any[]) => any; completeSimple: (...args: any[]) => any };
const unavailable = (): Measurement => ({ provenance: "unavailable" });
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function failure(error: unknown): Pick<CallRecord, "status" | "retry"> {
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown } | undefined;
  const status = e?.status ?? e?.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return { status: "error:http", retry: { kind: "http", httpStatus: status, retryable: status === 429 } };
  }
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(String(e?.code))) {
    return { status: "error:transport", retry: { kind: "transport", retryable: true } };
  }
  return { status: e?.name === "AbortError" ? "error:aborted" : "error:exception", retry: { retryable: false } };
}

export function observe<T extends Runtime>(original: T) {
  let phase: Phase = "subject";
  const records: CallRecord[] = [];
  function invoke(method: "streamSimple" | "completeSimple", model: any, context: Context, options?: any) {
    const started = performance.now();
    const record: CallRecord = {
      phase, requested: { provider: model.provider, id: model.id }, context: structuredClone(context),
      status: "ok", elapsedMs: 0, measurements: Object.fromEntries(fields.map(f => [f, unavailable()])) as Measurements,
      retry: { retryable: false },
    };
    const present = new Set<string>();
    const mark = (raw: any, mapping: Record<string, string>) => {
      if (!raw || typeof raw !== "object") return;
      for (const [source, target] of Object.entries(mapping)) if (finite(raw[source])) present.add(target);
    };
    const onProviderStreamEvent = (event: any, eventModel: any) => {
      if (model.api === "anthropic-messages") {
        const raw = event?.type === "message_start" ? event.message?.usage : event?.type === "message_delta" ? event.usage : undefined;
        mark(raw, { input_tokens: "input", output_tokens: "output", cache_read_input_tokens: "cacheRead", cache_creation_input_tokens: "cacheWrite" });
        if (["input", "output", "cacheRead", "cacheWrite"].every(f => present.has(f))) present.add("totalTokens");
      } else if (model.api === "openai-responses" && ["response.completed", "response.incomplete", "response.failed"].includes(event?.type)) {
        const raw = event.response?.usage;
        mark(raw, { input_tokens: "input", output_tokens: "output", total_tokens: "totalTokens" });
        mark(raw?.input_tokens_details, { cached_tokens: "cacheRead", cache_write_tokens: "cacheWrite" });
      }
      return options?.onProviderStreamEvent?.(event, eventModel);
    };
    let finished = false;
    const finish = (answer?: AssistantMessage, error?: unknown, rejected = false) => {
      if (finished) return;
      finished = true;
      record.elapsedMs = Math.max(0, performance.now() - started);
      if (rejected) Object.assign(record, failure(error));
      if (answer) {
        record.answered = { provider: answer.provider, id: answer.responseModel ?? answer.model };
        record.usage = answer.usage;
        if (answer.stopReason === "error" || answer.stopReason === "aborted") record.status = `error:${answer.stopReason}`;
        for (const f of fields) {
          if (f !== "cost" && present.has(f) && finite(answer.usage?.[f])) record.measurements[f] = { value: answer.usage[f], provenance: "measured" };
        }
        // These adapters calculate cost from catalog rates, including Copilot's adapters.
        const known = ["anthropic-messages", "openai-responses", "openai-completions"].includes(model.api);
        const priced = model.cost && Object.values(model.cost).some(v => finite(v) && v > 0);
        if (known && priced && present.size > 0 && finite(answer.usage?.cost?.total)) {
          record.measurements.cost = { value: answer.usage.cost.total, provenance: "estimated" };
        }
      }
      records.push(record);
    };
    let result: any;
    try {
      result = original[method].call(original, model, context, { ...options, onProviderStreamEvent });
    } catch (error) {
      finish(undefined, error, true);
      throw error;
    }
    if (method === "streamSimple") {
      result.result().then((answer: AssistantMessage) => finish(answer), (error: unknown) => finish(undefined, error, true));
      return result;
    }
    return Promise.resolve(result).then((answer: AssistantMessage) => { finish(answer); return answer; }, (error: unknown) => { finish(undefined, error, true); throw error; });
  }
  const wrappers = {
    streamSimple: (model: any, context: Context, options?: any) => invoke("streamSimple", model, context, options),
    completeSimple: (model: any, context: Context, options?: any) => invoke("completeSimple", model, context, options),
  };
  const bound = new Map<PropertyKey, unknown>();
  const runtime = new Proxy(original, {
    get(target, key) {
      if (key === "streamSimple" || key === "completeSimple") return wrappers[key];
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!bound.has(key)) bound.set(key, value.bind(target));
      return bound.get(key);
    },
  });
  return { runtime: runtime as T & Runtime, records, setPhase(next: Phase) { phase = next; } };
}

export function sumMeasurements(calls: readonly Measurements[]): Measurements {
  return Object.fromEntries(fields.map(field => {
    const values = calls.map(call => call[field]);
    if (!values.length || values.some(v => v.provenance === "unavailable")) return [field, unavailable()];
    return [field, { value: values.reduce((sum, v) => sum + v.value!, 0), provenance: values.some(v => v.provenance === "estimated") ? "estimated" : "measured" }];
  })) as Measurements;
}

export function classifySummarizer(records: readonly CallRecord[], expected: Identity, flushed: boolean): "ok" | "error:summarizer-fallback" | "error:summarizer" | "error:no-flush" {
  const calls = records.filter(record => record.phase === "summarizer");
  const matches = (identity: Identity) => identity.provider === expected.provider && identity.id === expected.id;
  if (calls.some(call => !matches(call.requested) || (call.answered && !matches(call.answered)))) return "error:summarizer-fallback";
  if (calls.some(call => call.status !== "ok")) return "error:summarizer";
  if (!flushed || !calls.some(call => call.status === "ok")) return "error:no-flush";
  return "ok";
}
