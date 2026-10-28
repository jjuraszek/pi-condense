import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ids = ["mid-result-fact", "unverified-hypothesis", "disproved-explanation", "failed-fix-not-disproof", "repeated-attempts-among-unrelated", "correction-then-topic-change", "approval-boundary"];

async function child() {
  const { runJob } = await import("./session");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { SUBJECT_MODEL, SUMMARIZER_MODELS, JUDGE_MODEL } = await import("./config");
  const [id, control, dir] = process.argv.slice(3);
  if (control === "stderr-pressure") {
    await new Promise<void>((resolve, reject) => process.stderr.write("x".repeat(1024 * 1024), error => error ? reject(error) : resolve()));
  }
  const scenario = structuredClone((await import(`./scenarios/${id}.ts`)).default);
  if (control === "trivial") for (const turn of scenario.history) if (turn.role === "result") turn.text = "tiny";
  if (control === "missing-index") {
    scenario.history.push({ role: "assistant", toolCalls: [{ id: "protected", name: "read", arguments: { path: "/orbital-ledger/skills/demo/SKILL.md" } }] }, { role: "result", toolCallId: "protected", toolName: "read", text: "protected".repeat(500) });
  }
  if (control === "partial-stubs") {
    scenario.history.push({ role: "assistant", toolCalls: [{ id: "second-result", name: "read", arguments: { path: "/orbital-ledger/notes/second.txt" } }] }, { role: "result", toolCallId: "second-result", toolName: "read", text: "second result".repeat(1000) });
  }
  let repo = resolve(import.meta.dir, "..");
  if (["extension", "tools", "context", "raw", "partial-stubs"].includes(control)) {
    const original = join(repo, "index.ts");
    repo = join(dir, "repo");
    await mkdir(repo);
    const hook = control === "extension" ? 'pi.on("session_start", () => { throw new Error("private error text"); });'
      : control === "tools" ? 'pi.on("session_start", () => pi.setActiveTools([]));'
      : control === "context" ? 'pi.on("before_agent_start", () => ({ systemPrompt: "unexpected" }));'
      : control === "partial-stubs" ? 'pi.on("context", event => ({ messages: event.messages.map(m => m.role === "toolResult" && m.toolCallId === "second-result" ? { ...m, content: [{ type: "text", text: "Not a short-ref stub." }] } : m) }));'
      : `pi.on("context", () => ({ messages: ${JSON.stringify((await import("./scenario")).seedEntries(scenario.history).filter((e: any) => e.type === "message").map((e: any) => e.message))} }));`;
    await writeFile(join(repo, "index.ts"), `import real from ${JSON.stringify(original)}; export default pi => { real(pi); ${hook} };`);
  }
  const models = [SUBJECT_MODEL, ...SUMMARIZER_MODELS, JUDGE_MODEL].map(key => {
    const [provider, id] = key.split("/");
    return { provider, id, name: id, api: "anthropic-messages", baseUrl: "https://invalid.invalid", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  });
  const getModel = (p: string, id: string) => models.find(m => m.provider === p && m.id === id);
  let subjectCalls = 0;
  const answer = (model: any, text: string, content?: any[]) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: content ?? [{ type: "text", text }], stopReason: content ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: .01, output: .01, cacheRead: 0, cacheWrite: 0, total: .02 } } });
  const runtime = {
    getModel, getPhysicalModel: getModel, getModels: () => models, getAvailableSnapshot: () => models,
    getRegisteredProviderIds: () => [], getError: () => undefined, getProvider: () => undefined,
    hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: "synthetic-offline" }, env: {} }),
    resolveModel: async (model: any, _messages: any, options: any) => ({ model, thinkingLevel: options.thinkingLevel }),
    completeSimple: async (model: any) => answer(model, '{"pass":true,"reason":"Synthetic oracle satisfied."}'),
    streamSimple(model: any, _context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        options?.onProviderStreamEvent?.({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, model);
        options?.onProviderStreamEvent?.({ type: "message_delta", usage: { output_tokens: 2 } }, model);
        const subject = model.id === SUBJECT_MODEL.split("/")[1];
        let msg;
        if (!subject) {
          msg = answer(control === "fallback" ? models[0] : model, "- Synthetic retained summary.");
          if (control === "summarizer-error") { msg.stopReason = "error"; msg.errorMessage = "private error text"; }
        } else {
          const required = scenario.mechanical.recovers ?? [];
          const calls = required.length && subjectCalls++ === 0 ? [{ type: "toolCall", id: "recovery", name: "context_tree_query", arguments: { toolCallIds: required.map((r: any) => {
            const stub = _context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === r.id);
            return stub?.content[0]?.text.match(/ref `([^`]+)`/)?.[1] ?? r.id;
          }) } }] : undefined;
          msg = answer(model, (scenario.mechanical.contains ?? ["Synthetic answer."]).join(" "), calls);
        }
        stream.push({ type: "start", partial: msg });
        stream.push(msg.stopReason === "error" ? { type: "error", reason: "error", error: msg } : { type: "done", reason: msg.stopReason, message: msg });
      });
      return stream;
    },
  };
  const result = await runJob({ scenario, summarizer: SUMMARIZER_MODELS[0], runIndex: 0, jobPath: dir, operatorAgentDir: join(dir, "operator"), repo, runtime: runtime as any, ...(control === "disabled" ? { settings: { enabled: false } } : {}) });
  console.log(JSON.stringify(result));
}

if (process.argv[2] === "--child") {
  await child();
} else {
  const { test, expect } = await import("bun:test");
  const { PIPELINE_SETTINGS, SUMMARIZER_MODELS } = await import("./config");
  async function run(id: string, control = "normal") {
    const dir = await mkdtemp(join(tmpdir(), "condense-lifecycle-"));
    const child = Bun.spawn([process.execPath, import.meta.path, "--child", id, control, dir], { env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") }, stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill(), 25000);
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    let stdout: string;
    try {
      const [out, stderr, exitCode] = await output;
      stdout = out;
      expect(exitCode, stderr.slice(-2000)).toBe(0);
    } finally {
      child.kill();
      await Promise.allSettled([output, child.exited]);
      clearTimeout(deadline);
    }
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(JSON.parse(await readFile(join(dir, "job.json"), "utf8"))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("private error text");
    expect(JSON.stringify(result)).not.toContain("synthetic-offline");
    expect(JSON.parse(await readFile(join(dir, "agent/settings.json"), "utf8"))).toEqual({ contextPrune: { ...PIPELINE_SETTINGS, summarizerModel: SUMMARIZER_MODELS[0], ...(control === "disabled" ? { enabled: false } : {}) } });
    expect(await readdir(join(dir, "cwd"))).toEqual([]);
    expect(await readdir(join(dir, "agent"))).not.toContain("auth.json");
    return result;
  }
  test.each(ids)("%s traverses real SDK flush, pruning, recovery and scoring", async id => {
    const result = await run(id);
    expect(result.status).toBe("ok");
    expect(result.verdict).toBe("pass");
    expect(result.records.some((r: any) => r.phase === "summarizer")).toBe(true);
    expect(result.records.some((r: any) => r.phase === "subject")).toBe(true);
    expect(result.recovery.every((r: any) => r.outcome === "hit")).toBe(true);
    for (const call of result.toolCalls) {
      expect(call.arguments.toolCallIds.every((ref: string) => /^t\d+$/.test(ref))).toBe(true);
      expect(call.resultIndex).toBeGreaterThan(call.index);
      expect(call.resultIndex).toBeLessThan(result.finalAssistantIndex);
    }
    expect(result.usage.subject.input.provenance).toBe("measured");
    expect(result.elapsedMs.total).toBeGreaterThanOrEqual(result.elapsedMs.flush + result.elapsedMs.probe);
  }, 30000);
  test("drains stderr while the child is still producing stdout", async () => {
    const result = await run("mid-result-fact", "stderr-pressure");
    expect(result.status).toBe("ok");
  }, 30000);
  test.each([
    ["disabled", "error:no-flush"], ["trivial", "error:no-flush"], ["missing-index", "error:no-flush"],
    ["extension", "error:extension"], ["tools", "error:isolation"], ["context", "error:isolation"],
    ["summarizer-error", "error:summarizer-fallback"], ["fallback", "error:summarizer-fallback"], ["raw", "error:not-pruned"], ["partial-stubs", "error:not-pruned"],
  ])("%s is a diagnostic error, not a behavioral failure", async (control, errorReason) => {
    const result = await run("mid-result-fact", control);
    expect(result.status).toBe("error");
    expect(result.errorReason).toBe(errorReason);
  }, 30000);
}
