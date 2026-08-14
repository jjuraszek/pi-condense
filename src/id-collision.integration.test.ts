import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "./indexer.js";
import { pruneMessages } from "./pruner.js";
import { detectChains } from "./chain-detector.js";
import { compressEligible } from "./chain-compressor.js";
import { captureUnindexedBatchesFromSession } from "./batch-capture.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import type { CapturedBatch } from "./types.js";

const user = (ts: number, text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const callTurn = (ts: number, ids: string[]) => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "toolCall", id, name: "bash", input: { cmd: id } })),
  timestamp: ts,
});
const result = (ts: number, id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: ts,
});
const finalTurn = (ts: number, text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts });

/**
 * The incident shape: two closeable chains, then a live turn reusing bash_23.
 * Pre-fix, the session-wide id-set drop deleted the live `bash_23` assistant
 * turn and left `LIVE 24` (`gauntlet_setting_24`) orphaned, which the
 * provider rejects with a 400.
 */
const buildSession = () => [
  user(1000, "1"),
  callTurn(1100, ["bash_18"]),
  result(1150, "bash_18", "OUT 18"),
  finalTurn(1200, "done 1"),
  user(2000, "2"),
  callTurn(2100, ["bash_23"]),
  result(2150, "bash_23", "OUT 23 first"),
  finalTurn(2200, "done 2"),
  user(3000, "3"),
  callTurn(3100, ["bash_23", "gauntlet_setting_24"]),
  result(3150, "bash_23", "LIVE 23"),
  result(3160, "gauntlet_setting_24", "LIVE 24"),
];

const batchFor = (turnIndex: number, ts: number, id: string, resultTs: number, text: string): CapturedBatch => ({
  turnIndex,
  timestamp: ts,
  assistantText: "",
  toolCalls: [{ toolCallId: id, toolName: "bash", args: { cmd: id }, resultText: text, isError: false, resultTimestamp: resultTs }],
});

/**
 * Indexes + summarizes the two older batches, then compresses their chains.
 * Mirrors index.ts's live-flush ordering and keying exactly: allocate refs ->
 * send/append the summary -> registerSummaryRefs -> addBatch ->
 * registerSummaryBody(<keys>). `keyer` controls the shape of the ids passed
 * to registerSummaryBody so both the production (bare-id) bug and the fixed
 * (occurrence-key) contract can be exercised with the same helper.
 */
const primeIndexer = async (
  messages: any[],
  keyer: (r: { toolCallId: string; resultTimestamp?: number }) => string = (r) =>
    `${r.toolCallId}@${r.resultTimestamp}`,
) => {
  const appended: Array<{ type: string; data: any }> = [];
  const indexer = new ToolCallIndexer();
  const append = (type: string, data?: unknown) => appended.push({ type, data });
  const refsByToolCallId = new Map<string, import("./types.js").SummaryToolCallRef>();

  for (const [turnIndex, spec] of [
    [0, { id: "bash_18", ts: 1000, resultTs: 1150, text: "OUT 18" }],
    [1, { id: "bash_23", ts: 2000, resultTs: 2150, text: "OUT 23 first" }],
  ] as const) {
    const batch = batchFor(turnIndex, spec.ts, spec.id, spec.resultTs, spec.text);
    const refs = indexer.allocateSummaryRefs(batch);
    // (send/append the summary message here in the real flush; no-op for this harness)
    indexer.registerSummaryRefs(refs);
    indexer.addBatch(batch, append);
    indexer.registerSummaryBody(refs.map(keyer), `summary of ${spec.id}`);
    for (const ref of refs) refsByToolCallId.set(ref.toolCallId, ref);
  }

  let nextBlock = 1;
  await compressEligible(detectChains(messages), 0, {
    indexer,
    blockRefs: { issue: () => `b${nextBlock++}` } as any,
    appendEntry: append,
    now: () => 9000,
    messages,
    diagnostics: { report: () => {} },
    backfill: { spillThreshold: 100_000, spillPreviewBytes: 500, sessionDir: "/tmp/unused", sessionId: "s" },
  });

  return { indexer, appended, refsByToolCallId };
};

const chainConfig = { enabled: true, rollingWindow: 0, stripFinalAssistantThinking: false, fuseRangeSummary: false } as any;
const syntheticsOf = (messages: any[]) =>
  messages.filter((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));

describe("id collision, end to end", () => {
  test("render keeps the live turn, drops both chain interiors, leaves no orphan", async () => {
    const messages = buildSession();
    const { indexer } = await primeIndexer(messages);
    const out = pruneMessages(messages, indexer, chainConfig);

    expect(out.pruned).toBe(true);
    // live turn intact, both results verbatim. Synthetics also carry
    // timestamp=compressedAt(9000) here, so they must be excluded from this
    // filter or they'd inflate the count - see chain-range-prune.test.ts's
    // "compressedAt kept below 3000" comment for the same caveat.
    const liveReal = out.messages.filter(
      (m: any) => m.timestamp >= 3000 && !(m.content?.[0]?.text ?? "").startsWith("<compressed-chain"),
    );
    expect(liveReal).toHaveLength(4);
    expect(out.messages.find((m: any) => m.timestamp === 3150).content[0].text).toBe("LIVE 23");
    expect(out.messages.find((m: any) => m.timestamp === 3160).content[0].text).toBe("LIVE 24");
    // both chain interiors gone, one synthetic each, bodies non-empty
    expect(out.messages.some((m: any) => m.timestamp === 1150 || m.timestamp === 2150)).toBe(false);
    const synthetics = syntheticsOf(out.messages);
    expect(synthetics).toHaveLength(2);
    const bash18Synthetic = synthetics.find((s: any) => s.content[0].text.includes("summary of bash_18"));
    const bash23Synthetic = synthetics.find((s: any) => s.content[0].text.includes("summary of bash_23"));
    expect(bash18Synthetic).toBeDefined();
    expect(bash23Synthetic).toBeDefined();
    expect(bash18Synthetic).not.toBe(bash23Synthetic);
    expect(bash18Synthetic.content[0].text).not.toContain("summary of bash_23");
    expect(bash23Synthetic.content[0].text).not.toContain("summary of bash_18");
    expectNoOrphanToolResults(out.messages);
  });

  // Regression for the live-flush bug (ref #8, index.ts registerSummaryBody
  // call): production must key registerSummaryBody with the occurrence key
  // (`id@resultTimestamp`), because hasPerBatchSummaryCoveringAny /
  // getPerBatchSummariesForToolCallIds are always queried with occurrence
  // keys (src/chain-compressor.ts's `lookupKeys`). Bare ids (`tc.toolCallId`)
  // silently mismatch and every chain is skipped as "no-summary" - it only
  // appears to work after a restart because reconstructFromSession rebuilds
  // bodies from summary refs, which DO carry resultTimestamp. The default
  // `keyer` on primeIndexer above pins the correct (occurrence-key) shape;
  // this test pins the failure mode of the bare-id shape as a contrast.
  test("live-flush occurrence-key contract: chains compress with non-empty, per-chain-distinct bodies", async () => {
    const messages = buildSession();
    const { indexer } = await primeIndexer(messages); // default keyer = occurrence key, i.e. the fixed index.ts contract
    const out = pruneMessages(messages, indexer, chainConfig);

    const synthetics = syntheticsOf(out.messages);
    expect(synthetics).toHaveLength(2);
    expect(synthetics.some((s: any) => s.content[0].text.includes("summary of bash_18"))).toBe(true);
    expect(synthetics.some((s: any) => s.content[0].text.includes("summary of bash_23"))).toBe(true);
    expectNoOrphanToolResults(out.messages);
  });

  // Regression for the bare-id keying bug (ref #8): registerSummaryBody keyed
  // with `tc.toolCallId` (no resultTimestamp) mismatches hasPerBatchSummaryCoveringAny's
  // occurrence-key lookups, so both chains fall through to the "no per-batch
  // summary covers this span" branch. Pre-2026-08-14 that branch was a permanent
  // no-summary skip (the bug this test used to pin). Since the deterministic
  // backfill fallback (doc/specs/2026-08-14-uncovered-chain-deterministic-backfill.md),
  // that branch instead compresses deterministically from already-indexed
  // records (both chains' tool calls were indexed via addBatch, just not
  // summary-covered under the right key) - so the keying bug can no longer
  // strand a chain through this path. Pin the new correct behavior instead.
  test("live-flush bare-id keying bug: chains compress deterministically instead of stranding", async () => {
    const messages = buildSession();
    // Mirrors the production BUG exactly: `tc.toolCallId` with no resultTimestamp,
    // matching index.ts's pre-fix `batch.toolCalls.map((tc) => tc.toolCallId)`.
    const { indexer } = await primeIndexer(messages, (r) => r.toolCallId);
    const out = pruneMessages(messages, indexer, chainConfig);

    const synthetics = syntheticsOf(out.messages);
    expect(synthetics).toHaveLength(2);
    for (const s of synthetics) {
      expect(s.content[0].text).toContain("Deterministic chain compression");
      expect(s.content[0].text).toMatch(/Refs: t\d+/);
    }
    expectNoOrphanToolResults(out.messages);
  });

  test("re-rendering the same session is deep-equal", async () => {
    const messages = buildSession();
    const { indexer } = await primeIndexer(messages);
    const first = pruneMessages(messages, indexer, chainConfig);
    const second = pruneMessages(first.messages, indexer, chainConfig);
    expect(second.messages).toEqual(first.messages);
    expectNoOrphanToolResults(second.messages);
  });

  test("G4/C2: a live collision batch is captured (not filtered as summarized) and separately addressable after summarization", () => {
    // Prime the indexer with an already-summarized bash_23 occurrence.
    const indexer = new ToolCallIndexer();
    indexer.addBatch(
      {
        turnIndex: 0,
        timestamp: 2000,
        assistantText: "",
        toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "OUT 23 first", isError: false, resultTimestamp: 2150 }],
      },
      () => {},
    );
    expect(indexer.isSummarized("bash_23@2150")).toBe(true);

    // A NEW live occurrence of the same bare id, at a later resultTimestamp,
    // not yet in the index.
    const branch = [
      { type: "message", message: user(3000, "3") },
      { type: "message", message: callTurn(3100, ["bash_23"]) },
      { type: "message", message: result(3150, "bash_23", "LIVE 23") },
    ];

    const batches = captureUnindexedBatchesFromSession(branch, indexer);
    // The live occurrence must be captured, NOT skipped as already-summarized -
    // isSummarized is asked with the occurrence key (bash_23@3150), which is
    // distinct from the primed bash_23@2150.
    expect(batches).toHaveLength(1);
    expect(batches[0].toolCalls).toHaveLength(1);
    expect(batches[0].toolCalls[0].toolCallId).toBe("bash_23");
    expect(batches[0].toolCalls[0].resultTimestamp).toBe(3150);
    expect(batches[0].toolCalls[0].resultText).toBe("LIVE 23");

    // Capture it into the index (mirrors a successful summarization flush) and
    // confirm both occurrences remain separately addressable.
    indexer.addBatch(batches[0], () => {});
    expect(indexer.getRecord("bash_23@2150")?.resultText).toBe("OUT 23 first");
    expect(indexer.getRecord("bash_23@3150")?.resultText).toBe("LIVE 23");
    expect(indexer.isSummarized("bash_23@3150")).toBe(true);
  });

  test("a restart-shaped rebuild reproduces both tN refs and non-empty synthetics", async () => {
    const messages = buildSession();
    const { appended, refsByToolCallId } = await primeIndexer(messages);

    // Replay only what the session would hold: index, summary and chain entries.
    const branch: any[] = [];
    for (const { type, data } of appended) {
      if (type === CUSTOM_TYPE_INDEX) branch.push({ type: "custom", customType: CUSTOM_TYPE_INDEX, data });
      if (type === CUSTOM_TYPE_CHAIN) branch.push({ type: "custom", customType: CUSTOM_TYPE_CHAIN, data });
    }
    // Use the refs the flush actually allocated (via allocateSummaryRefs), not
    // hand-picked shortIds - this proves the restart replay honors whatever
    // numbering the flush produced instead of assuming t1/t2.
    for (const id of ["bash_18", "bash_23"]) {
      const ref = refsByToolCallId.get(id);
      if (!ref) throw new Error(`primeIndexer did not allocate a ref for ${id}`);
      branch.push({
        type: "custom_message",
        customType: CUSTOM_TYPE_SUMMARY,
        content: `summary of ${id}`,
        details: { toolCallRefs: [ref] },
      });
    }

    const [ref18, ref23] = [refsByToolCallId.get("bash_18")!, refsByToolCallId.get("bash_23")!];
    const rebuilt = new ToolCallIndexer();
    rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => branch } } as any);
    expect(rebuilt.getRecord(ref18.shortId)?.resultText).toBe("OUT 18");
    expect(rebuilt.getRecord(ref23.shortId)?.resultText).toBe("OUT 23 first");

    const out = pruneMessages(buildSession(), rebuilt, chainConfig);
    const synthetics = syntheticsOf(out.messages);
    expect(synthetics).toHaveLength(2);
    expect(synthetics.some((s: any) => s.content[0].text.includes("summary of bash_18"))).toBe(true);
    expect(synthetics.some((s: any) => s.content[0].text.includes("summary of bash_23"))).toBe(true);
    expectNoOrphanToolResults(out.messages);
  });
});
