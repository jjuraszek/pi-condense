import { describe, expect, it } from "bun:test";
import { pruneMessages, sizeMessages } from "./pruner.js";
import { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";
import type { ChainCompressionConfig, ChainCompressionEntry } from "./types.js";
import { DiagnosticSink } from "./diagnostics.js";
import { pruneWithZeroSweepAssertion } from "./test-support.js";

// Minimal mock exposing only the ToolCallIndexer surface that pruneMessages calls.
// `hasLegacyBareRecord` defaults to the bare `summarized` set: most of the fixture
// messages in this file carry no occurrence-keyed records, so the fail-closed lookup
// in pruneMessages falls through to this legacy-bare-id path for them, matching how
// pre-upgrade sessions behave (that path must stay covered - it is a supported
// shape). The "occurrence-keyed coverage" describe block below seeds `summarized` /
// `records` / `shortRefs` with `id@timestamp`-shaped keys instead, so those tests
// hit `isSummarized(key)` directly - the occurrence branch of the ladder - rather
// than falling through to `hasLegacyBareRecord`.
function makeMockIndexer({
  summarized = new Set<string>(),
  shortRefs = new Map<string, string>(),
  chainEntries = [] as ChainCompressionEntry[],
  summaryBodyMap = new Map<string, string>(),
  records = new Map<string, any>(),
}: {
  summarized?: Set<string>;
  shortRefs?: Map<string, string>;
  chainEntries?: ChainCompressionEntry[];
  summaryBodyMap?: Map<string, string>;
  records?: Map<string, any>;
} = {}) {
  return {
    isSummarized: (id: string) => summarized.has(id),
    hasLegacyBareRecord: (id: string) => summarized.has(id),
    getShortRefForToolCallId: (id: string) => shortRefs.get(id),
    getRecord: (id: string) => records.get(id),
    getChainEntries: () => chainEntries,
    getPerBatchSummaryTextForToolCallIds: (ids: string[]) => {
      for (const id of ids) {
        const text = summaryBodyMap.get(id);
        if (text) return text;
      }
      return "";
    },
  } as any;
}

const enabledCC: ChainCompressionConfig = {
  enabled: true,
  rollingWindow: 0,
  stripFinalAssistantThinking: true,
  fuseRangeSummary: false,
};

describe("pruneMessages", () => {
  it("stub-replaces a summarized tool result", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      shortRefs: new Map([["tc1", "t1"]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "big output" }],
        isError: false,
        timestamp: 1,
      },
    ];
    const { messages: out, pruned } = pruneMessages(messages, indexer);
    expect(pruned).toBe(true);
    expect(out[1].content[0].text).toContain("`t1`");
    expect(out[1].content[0].text).toContain("context_tree_query");
  });

  it("returns original array reference when nothing is summarized or compressed", () => {
    const indexer = makeMockIndexer();
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const { messages: out, pruned } = pruneMessages(messages, indexer, enabledCC);
    expect(pruned).toBe(false);
    expect(out).toBe(messages);
  });

  it("applies chain compression after stub-replace", () => {
    const toolCallId = "tc-mid";
    const chainEntry: ChainCompressionEntry = {
      blockId: "b1",
      startUserTimestamp: 100,
      droppedToolCallIds: [toolCallId],
      finalAssistantTimestamp: 300,
      toolRefs: ["t1"],
      compressedAt: 999,
    };
    const summaryText = "ran bash, got results";
    const indexer = makeMockIndexer({
      summarized: new Set([toolCallId]),
      shortRefs: new Map([[toolCallId, "t1"]]),
      chainEntries: [chainEntry],
      summaryBodyMap: new Map([[toolCallId, summaryText]]),
    });

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 100 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }],
        timestamp: 200,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 210,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 300,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "end_turn",
      },
    ];

    const { messages: out, pruned } = pruneMessages(messages, indexer, enabledCC);
    expect(pruned).toBe(true);

    // Middle assistant + toolResult are dropped
    const roles = out.map((m: any) => m.role);
    expect(roles.filter((r: string) => r === "toolResult")).toHaveLength(0);

    // Synthetic chain message injected after the start user message
    const synthetic = out.find(
      (m: any) =>
        m.role === "user" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("<compressed-chain"),
    );
    expect(synthetic).toBeDefined();
    expect(synthetic.content[0].text).toContain('id="b1"');
    expect(synthetic.content[0].text).toContain('tools="t1"');
    expect(synthetic.content[0].text).toContain(summaryText);

    // Start user message still present
    const startUser = out.find((m: any) => m.role === "user" && m.timestamp === 100);
    expect(startUser).toBeDefined();

    // Final assistant kept (no thinking block to strip here)
    const finalAsst = out.find((m: any) => m.role === "assistant" && m.timestamp === 300);
    expect(finalAsst).toBeDefined();

    // Ordering: start user → synthetic → final assistant
    const startIdx = out.indexOf(startUser);
    const synthIdx = out.indexOf(synthetic);
    const finalIdx = out.indexOf(finalAsst);
    expect(startIdx).toBeLessThan(synthIdx);
    expect(synthIdx).toBeLessThan(finalIdx);
  });

  it("prefers rangeSummaryText over per-batch concat in the synthetic body (B)", () => {
    const toolCallId = "tc-range";
    const chainEntry: ChainCompressionEntry = {
      blockId: "b9",
      startUserTimestamp: 100,
      droppedToolCallIds: [toolCallId],
      finalAssistantTimestamp: 300,
      toolRefs: ["t9"],
      compressedAt: 777,
      rangeSummaryText: "FUSED cohesive summary",
    };
    const indexer = makeMockIndexer({
      chainEntries: [chainEntry],
      summaryBodyMap: new Map([[toolCallId, "per-batch concat body"]]),
    });
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
      { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: 210 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 300, usage: {}, stopReason: "end_turn" },
    ];
    const { messages: out } = pruneMessages(messages, indexer, enabledCC);
    const synthetic = out.find((m: any) => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"));
    expect(synthetic.content[0].text).toContain("FUSED cohesive summary");
    expect(synthetic.content[0].text).not.toContain("per-batch concat body");
  });

  it("strips thinking blocks from final assistant when stripFinalAssistantThinking is true", () => {
    const toolCallId = "tc-think";
    const chainEntry: ChainCompressionEntry = {
      blockId: "b2",
      startUserTimestamp: 100,
      droppedToolCallIds: [toolCallId],
      finalAssistantTimestamp: 300,
      toolRefs: ["t2"],
      compressedAt: 888,
    };
    const indexer = makeMockIndexer({
      summarized: new Set([toolCallId]),
      shortRefs: new Map([[toolCallId, "t2"]]),
      chainEntries: [chainEntry],
      summaryBodyMap: new Map([[toolCallId, "summary"]]),
    });

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "think" }], timestamp: 100 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }],
        timestamp: 200,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "out" }],
        isError: false,
        timestamp: 210,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thoughts", thinkingSignature: "sig123" },
          { type: "text", text: "answer" },
        ],
        timestamp: 300,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "end_turn",
      },
    ];

    const { messages: out } = pruneMessages(messages, indexer, enabledCC);
    const finalAsst = out.find((m: any) => m.role === "assistant" && m.timestamp === 300);
    expect(finalAsst).toBeDefined();
    const contentTypes = finalAsst.content.map((c: any) => c.type);
    expect(contentTypes).not.toContain("thinking");
    expect(contentTypes).toContain("text");
  });

  it("purges errored toolCall args through errorPurge wiring", () => {
    const indexer = makeMockIndexer();
    const largeArgs = { content: "x".repeat(200) };
    const messages: any[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-err", name: "write", arguments: largeArgs }],
        timestamp: 100,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "tc-err",
        toolName: "write",
        content: [{ type: "text", text: "Error: permission denied" }],
        isError: true,
        timestamp: 110,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { cmd: "ls" } }],
        timestamp: 200,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 210,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc3", name: "bash", arguments: { cmd: "pwd" } }],
        timestamp: 300,
        api: "anthropic",
        provider: "anthropic",
        model: "x",
        usage: {},
        stopReason: "tool_use",
      },
      {
        role: "toolResult",
        toolCallId: "tc3",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 310,
      },
    ];
    const { messages: out, pruned } = pruneMessages(
      messages,
      indexer,
      { enabled: false, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: false },
      { enabled: true, cooldownTurns: 2, minArgChars: 100 },
    );
    expect(pruned).toBe(true);
    const errAsst = out.find((m: any) => m.role === "assistant" && m.timestamp === 100) as any;
    expect(errAsst).toBeDefined();
    expect(errAsst.content[0].arguments._purged).toMatch(/^<purged-errored-args size=/);
  });

  it("spill stub tolerates absent spillBytes/resultPreview", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      records: new Map([["tc1", {
        toolCallId: "tc1", toolName: "bash", args: {}, resultText: "",
        spillPath: "/blobs/tc1.txt", isError: false, turnIndex: 0, timestamp: 1,
      }]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }], timestamp: 0 },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 },
    ];
    const { messages: out } = pruneMessages(messages, indexer);
    const text = out[1].content[0].text as string;
    expect(text).toContain("/blobs/tc1.txt");
    expect(text).toContain("?");
    expect(text).not.toContain("Summarized in pruner summary");
  });

  it("emits a mechanical spill stub for a spilled record", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      records: new Map([["tc1", {
        toolCallId: "tc1", toolName: "fetch", args: { url: "https://x" },
        resultText: "", resultPreview: "PREVIEW-HEAD", spillPath: "/blobs/tc1.txt",
        spillBytes: 1048576, isError: false, turnIndex: 0, timestamp: 1,
      }]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "fetch", input: {} }], timestamp: 0 },
      {
        role: "toolResult", toolCallId: "tc1", toolName: "fetch",
        content: [{ type: "text", text: "huge" }], isError: false, timestamp: 1,
      },
    ];
    const { messages: out, pruned } = pruneMessages(messages, indexer);
    expect(pruned).toBe(true);
    const text = out[1].content[0].text as string;
    expect(text).toContain("/blobs/tc1.txt");
    expect(text).toContain("PREVIEW-HEAD");
    expect(text).toContain("1048576");
    expect(text).not.toContain("Summarized in pruner summary");
  });

  it("skips chain compression when disabled", () => {
    const chainEntry: ChainCompressionEntry = {
      blockId: "b1",
      startUserTimestamp: 100,
      droppedToolCallIds: ["tc-x"],
      finalAssistantTimestamp: 200,
      toolRefs: [],
      compressedAt: 999,
    };
    const indexer = makeMockIndexer({ chainEntries: [chainEntry] });
    const messages = [
      { role: "user", content: "hi", timestamp: 100 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc-x", name: "bash", input: {} }], timestamp: 140 },
      {
        role: "toolResult",
        toolCallId: "tc-x",
        toolName: "bash",
        content: [],
        isError: false,
        timestamp: 150,
      },
    ];
    const disabled: ChainCompressionConfig = { ...enabledCC, enabled: false };
    const { pruned } = pruneMessages(messages, indexer, disabled);
    // tc-x is not in summarized set, so stub-replace doesn't fire; chain disabled
    expect(pruned).toBe(false);
  });

  it("leaves thinking blocks on every assistant turn (no thinking-strip phase)", () => {
    const indexer = makeMockIndexer({ summarized: new Set(["c10"]), shortRefs: new Map([["c10", "t1"]]) });
    const mkAsst = (ts: number) => ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", thinkingSignature: "s" },
        { type: "text", text: "x" },
        { type: "toolCall", id: `c${ts}`, name: "bash", arguments: {} },
      ],
      timestamp: ts,
      usage: {},
      stopReason: "tool_use",
    });
    const messages: any[] = [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }];
    for (let i = 0; i < 5; i++) {
      const id = `c${10 + i}`;
      messages.push(mkAsst(10 + i));
      messages.push({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "o" }], isError: false, timestamp: 100 + i });
    }
    const { messages: out, pruned } = pruneMessages(messages, indexer, {
      enabled: true, rollingWindow: 0, stripFinalAssistantThinking: false, fuseRangeSummary: false,
    });
    // Phase 1 still fires: c10's toolResult is stub-replaced.
    expect(pruned).toBe(true);
    const tr = out.find((m: any) => m.role === "toolResult" && m.toolCallId === "c10") as any;
    expect(tr.content[0].text).toContain("`t1`");
    // No phase strips thinking any more — all five assistants keep theirs.
    const assistants = out.filter((m: any) => m.role === "assistant");
    expect(assistants.length).toBe(5);
    expect(assistants.every((a: any) => a.content.some((c: any) => c.type === "thinking"))).toBe(true);
  });
});

describe("render-time protection re-check", () => {
  const skillAsst = { role: "assistant", content: [{ type: "toolCall", id: "tc-skill", name: "read", input: {} }], timestamp: 5 };
  const skillMsg = {
    role: "toolResult",
    toolCallId: "tc-skill",
    toolName: "read",
    content: [{ type: "text", text: "FULL SKILL BODY" }],
    isError: false,
    timestamp: 10,
  };

  const indexer = makeMockIndexer({
    summarized: new Set(["tc-skill"]),
    shortRefs: new Map([["tc-skill", "t1"]]),
    records: new Map([["tc-skill", {
      toolCallId: "tc-skill",
      toolName: "read",
      args: { path: "/h/skills/x/SKILL.md" },
      resultText: "",
      isError: false,
      turnIndex: 0,
      timestamp: 10,
    }]]),
  });

  it("leaves a summarized record verbatim once its path matches protectedPaths", () => {
    const { messages, pruned } = pruneMessages(
      [skillAsst, skillMsg], indexer as any, undefined, undefined,
      { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] },
    );
    expect(pruned).toBe(false);
    expect(messages[1].content[0].text).toBe("FULL SKILL BODY");
  });

  it("still stubs when no protection config is passed", () => {
    const { messages, pruned } = pruneMessages([skillAsst, skillMsg], indexer as any);
    expect(pruned).toBe(true);
    expect(messages[1].content[0].text).toContain("context_tree_query");
  });
});

describe("pruneMessages recovery grace", () => {
  const mkQueryResult = (toolCallId: string, timestamp: number) => ({
    role: "toolResult",
    toolCallId,
    toolName: "context_tree_query",
    content: [{ type: "text", text: "VERBATIM RECOVERY OUTPUT" }],
    isError: false,
    timestamp,
  });
  const mkUser = (timestamp: number) => ({ role: "user", content: [{ type: "text", text: "go" }], timestamp });
  const mkAsst = (toolCallId: string, toolName: string, timestamp: number) => ({
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, input: {} }],
    timestamp,
  });

  it("renders a context_tree_query recovery output verbatim at age 0 within grace", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    expect(out[1].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("stubs a context_tree_query recovery output aged past the grace window", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages: any[] = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    const tr = out.find((m: any) => m.toolCallId === "tc-recover") as any;
    expect(tr.content[0].text).toContain("context_tree_query");
    expect(tr.content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("stubs at age 0 when recoveryGraceTurns is 0 (feature off)", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 0);
    expect(out[1].content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(out[1].content[0].text).toContain("context_tree_query");
  });

  it("does not apply the grace window to non-context_tree_query outputs", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-bash"]),
      shortRefs: new Map([["tc-bash", "t1"]]),
    });
    const messages = [
      mkAsst("tc-bash", "bash", 0),
      {
        role: "toolResult",
        toolCallId: "tc-bash",
        toolName: "bash",
        content: [{ type: "text", text: "VERBATIM RECOVERY OUTPUT" }],
        isError: false,
        timestamp: 1,
      },
    ];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    expect(out[1].content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(out[1].content[0].text).toContain("context_tree_query");
  });

  it("isProtected precedence: a protected context_tree_query output stays verbatim even with grace off", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
      records: new Map([["tc-recover", {
        toolCallId: "tc-recover", toolName: "context_tree_query", args: { path: "/h/skills/x/SKILL.md" },
        resultText: "", isError: false, turnIndex: 0, timestamp: 1,
      }]]),
    });
    const messages: any[] = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(
      messages, indexer, undefined, undefined,
      { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] },
      0,
    );
    const tr = out.find((m: any) => m.toolCallId === "tc-recover") as any;
    expect(tr.content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("renders a spilled context_tree_query recovery output verbatim at age 0 within grace", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
      records: new Map([["tc-recover", {
        toolCallId: "tc-recover", toolName: "context_tree_query", args: {},
        resultText: "", resultPreview: "PREVIEW-HEAD", spillPath: "/blobs/tc-recover.txt",
        spillBytes: 1048576, isError: false, turnIndex: 0, timestamp: 1,
      }]]),
    });
    const messages = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    expect(out[1].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("stubs a spilled context_tree_query recovery output aged past the grace window to the spill-pointer stub", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
      records: new Map([["tc-recover", {
        toolCallId: "tc-recover", toolName: "context_tree_query", args: {},
        resultText: "", resultPreview: "PREVIEW-HEAD", spillPath: "/blobs/tc-recover.txt",
        spillBytes: 1048576, isError: false, turnIndex: 0, timestamp: 1,
      }]]),
    });
    const messages: any[] = [mkAsst("tc-recover", "context_tree_query", 0), mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    const tr = out.find((m: any) => m.toolCallId === "tc-recover") as any;
    expect(tr.content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(tr.content[0].text).toContain("/blobs/tc-recover.txt");
    expect(tr.content[0].text).toContain("spilled");
  });
});

describe("occurrence-keyed stub replacement", () => {
  it("stubs the summarized occurrence and leaves the live one verbatim", () => {
    const idx = new ToolCallIndexer();
    idx.addBatch(
      {
        turnIndex: 0,
        timestamp: 1000,
        assistantText: "",
        toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "OLD", isError: false, resultTimestamp: 1150 }],
      } as any,
      () => {},
    );
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 1100 },
      { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 1150 },
      { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 3100 },
      { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 3150 },
    ];
    const out = pruneMessages(messages, idx);
    expect(out.messages[1].content[0].text).toContain("Summarized in pruner summary");
    expect(out.messages[3].content[0].text).toBe("LIVE");
  });

  it("fail-closed: a timestamped result with no occurrence record is never stubbed", () => {
    const idx = new ToolCallIndexer();
    idx.addBatch(
      {
        turnIndex: 0,
        timestamp: 1000,
        assistantText: "",
        toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "OLD", isError: false, resultTimestamp: 1150 }],
      } as any,
      () => {},
    );
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 9100 },
      { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 9150 },
    ];
    const out = pruneMessages(messages, idx);
    expect(out.pruned).toBe(false);
    expect(out.messages).toBe(messages);
  });

  it("fail-closed: a mixed legacy+occurrence bare id does not stub a live later occurrence (F1 regression)", () => {
    const idx = new ToolCallIndexer();
    idx.reconstructFromSession({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: CUSTOM_TYPE_INDEX,
            data: { toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "OLD-LEGACY", isError: false, turnIndex: 0, timestamp: 500 }] },
          },
        ],
      },
    } as any);
    idx.addBatch(
      {
        turnIndex: 1,
        timestamp: 2000,
        assistantText: "",
        toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "MID", isError: false, resultTimestamp: 2150 }],
      } as any,
      () => {},
    );
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 9100 },
      { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 9150 },
    ];
    const out = pruneMessages(messages, idx);
    expect(out.messages[1].content[0].text).toBe("LIVE");
    expect(out.pruned).toBe(false);
  });

  it("legacy bare-id records still stub (pre-upgrade sessions keep working)", () => {
    const idx = new ToolCallIndexer();
    idx.reconstructFromSession({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: CUSTOM_TYPE_INDEX,
            data: { toolCalls: [{ toolCallId: "bash_7", toolName: "bash", args: {}, resultText: "OLD", isError: false, turnIndex: 0, timestamp: 500 }] },
          },
        ],
      },
    } as any);
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "bash_7", name: "bash", input: {} }], timestamp: 500 },
      { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 550 },
    ];
    const out = pruneMessages(messages, idx);
    expect(out.pruned).toBe(true);
    expect(out.messages[1].content[0].text).toContain("Summarized in pruner summary");
  });

  it("accepted limitation: a pure-legacy summarized bash_7 stubs a LIVE colliding bash_7 result (pre-upgrade sessions only)", () => {
    const idx = new ToolCallIndexer();
    idx.reconstructFromSession({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: CUSTOM_TYPE_INDEX,
            data: { toolCalls: [{ toolCallId: "bash_7", toolName: "bash", args: {}, resultText: "OLD", isError: false, turnIndex: 0, timestamp: 500 }] },
          },
        ],
      },
    } as any);

    // No migration: a bare-keyed legacy record has no occurrence-keyed
    // siblings, so hasLegacyBareRecord stays true even though a later, live,
    // unrelated occurrence of the same reused provider id now exists.
    expect(idx.hasLegacyBareRecord("bash_7")).toBe(true);

    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "bash_7", name: "bash", input: {} }], timestamp: 9100 },
      { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 9150 },
    ];
    const out = pruneMessages(messages, idx);
    // Accepted, documented exposure (PRUNING.md): a session spanning the
    // upgrade keeps this pre-upgrade behavior for its legacy half - the live
    // result is stub-replaced with the stale legacy record's content.
    expect(out.pruned).toBe(true);
    expect(out.messages[1].content[0].text).toContain("Summarized in pruner summary");
  });
});

describe("orphan sweep in pruneMessages", () => {
  it("a clean render returns the identical array reference with pruned false", () => {
    const idx = new ToolCallIndexer();
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", input: {} }], timestamp: 1 },
      { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 2 },
    ];
    const out = pruneMessages(messages, idx);
    expect(out.messages).toBe(messages);
    expect(out.pruned).toBe(false);
    expect(out.beforeChars).toBe(0);
  });

  it("sweeps an orphan and reports the diagnostic once across repeated renders of the same input", () => {
    const idx = new ToolCallIndexer();
    const appended: any[] = [];
    const sink = new DiagnosticSink((_customType, data) => appended.push(data));
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", input: {} }], timestamp: 1 },
      { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "ghost", toolName: "bash", content: [{ type: "text", text: "y" }], isError: false, timestamp: 3 },
    ];
    const first = pruneMessages(messages, idx, undefined, undefined, undefined, 0, sink as any);
    expect(first.pruned).toBe(true);
    expect(first.messages).toHaveLength(2);
    expect(first.messages.some((m: any) => m.toolCallId === "ghost")).toBe(false);
    expect(first.messages.some((m: any) => m.toolCallId === "a")).toBe(true);

    // Same orphan on a second render of the same (still-unsupplemented) input
    // must not write a second diagnostic entry: DiagnosticSink dedups per
    // (kind, dedupKey), and pruneMessages must compute the same dedupKey both
    // times for the same swept id set.
    const second = pruneMessages(messages, idx, undefined, undefined, undefined, 0, sink as any);
    expect(second.pruned).toBe(true);

    expect(appended).toHaveLength(1);
    expect(appended[0].kind).toBe("orphan-sweep");
    expect(appended[0].detail).toContain("ghost");
    expect(appended[0].detail).toContain("swept 1 orphan");
  });

  it("bounds the sweep dedup key and truncation marker for a large orphan set", () => {
    const idx = new ToolCallIndexer();
    const reports: any[] = [];
    const sink = { report: (kind: string, key: string, detail: string) => reports.push({ kind, key, detail }), counts: () => ({}) as any };
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "keep", name: "bash", input: {} }], timestamp: 1 },
      { role: "toolResult", toolCallId: "keep", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 2 },
    ];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "toolResult", toolCallId: `ghost-${i}`, toolName: "bash", content: [{ type: "text", text: "y" }], isError: false, timestamp: 3 + i });
    }
    const out = pruneMessages(messages, idx, undefined, undefined, undefined, 0, sink as any);
    expect(out.pruned).toBe(true);
    expect(reports).toHaveLength(1);
    // A short, bounded hash key regardless of how many ids were swept.
    expect(reports[0].key.length).toBe(16);
    expect(reports[0].detail).toContain("swept 12 orphan");
    expect(reports[0].detail).toContain("... +7 more");
  });
});

describe("occurrence-keyed coverage via mock indexer (spill / protection / grace)", () => {
  it("stub-replaces via a direct occurrence-key hit (not the legacy branch)", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1@1500"]),
      shortRefs: new Map([["tc1@1500", "t1"]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }], timestamp: 1400 },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "big output" }], isError: false, timestamp: 1500 },
    ];
    const { messages: out, pruned } = pruneMessages(messages, indexer);
    expect(pruned).toBe(true);
    expect(out[1].content[0].text).toContain("`t1`");
  });

  it("emits the mechanical spill stub via a direct occurrence-key hit", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1@1500"]),
      records: new Map([["tc1@1500", {
        toolCallId: "tc1", toolName: "fetch", args: { url: "https://x" },
        resultText: "", resultPreview: "PREVIEW-HEAD", spillPath: "/blobs/tc1.txt",
        spillBytes: 1048576, isError: false, turnIndex: 0, resultTimestamp: 1500, timestamp: 1400,
      }]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "fetch", input: {} }], timestamp: 1400 },
      { role: "toolResult", toolCallId: "tc1", toolName: "fetch", content: [{ type: "text", text: "huge" }], isError: false, timestamp: 1500 },
    ];
    const { messages: out, pruned } = pruneMessages(messages, indexer);
    expect(pruned).toBe(true);
    const text = out[1].content[0].text as string;
    expect(text).toContain("/blobs/tc1.txt");
    expect(text).toContain("PREVIEW-HEAD");
    expect(text).not.toContain("Summarized in pruner summary");
  });

  it("render-time protection re-check applies to a direct occurrence-key hit", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-skill@1500"]),
      shortRefs: new Map([["tc-skill@1500", "t1"]]),
      records: new Map([["tc-skill@1500", {
        toolCallId: "tc-skill", toolName: "read", args: { path: "/h/skills/x/SKILL.md" },
        resultText: "", isError: false, turnIndex: 0, resultTimestamp: 1500, timestamp: 1400,
      }]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc-skill", name: "read", input: {} }], timestamp: 1400 },
      { role: "toolResult", toolCallId: "tc-skill", toolName: "read", content: [{ type: "text", text: "FULL SKILL BODY" }], isError: false, timestamp: 1500 },
    ];
    const { messages: out, pruned } = pruneMessages(
      messages, indexer, undefined, undefined,
      { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] },
    );
    expect(pruned).toBe(false);
    expect(out[1].content[0].text).toBe("FULL SKILL BODY");
  });

  it("recovery grace protects a direct occurrence-key hit at age 0", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover@1500"]),
      shortRefs: new Map([["tc-recover@1500", "t1"]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc-recover", name: "context_tree_query", input: {} }], timestamp: 1400 },
      { role: "toolResult", toolCallId: "tc-recover", toolName: "context_tree_query", content: [{ type: "text", text: "VERBATIM RECOVERY OUTPUT" }], isError: false, timestamp: 1500 },
    ];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    expect(out[1].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("a graced occurrence does not protect a different occurrence of the same reused bare id", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["reused@1500", "reused@9500"]),
      shortRefs: new Map([["reused@1500", "t1"], ["reused@9500", "t2"]]),
    });
    const messages = [
      // Graced context_tree_query recovery at occurrence reused@1500 (age 0).
      { role: "assistant", content: [{ type: "toolCall", id: "reused", name: "context_tree_query", input: {} }], timestamp: 1400 },
      { role: "toolResult", toolCallId: "reused", toolName: "context_tree_query", content: [{ type: "text", text: "VERBATIM RECOVERY OUTPUT" }], isError: false, timestamp: 1500 },
      // A LATER, unrelated summarized occurrence of the same reused provider id.
      { role: "assistant", content: [{ type: "toolCall", id: "reused", name: "bash", input: {} }], timestamp: 9400 },
      { role: "toolResult", toolCallId: "reused", toolName: "bash", content: [{ type: "text", text: "different output" }], isError: false, timestamp: 9500 },
    ];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, 3);
    // The grace-protected recovery output stays verbatim...
    expect(out[1].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
    // ...but the later, different occurrence of the same bare id is NOT
    // shielded by that grace entry - it gets stubbed on its own merits.
    expect(out[3].content[0].text).toContain("`t2`");
    expect(out[3].content[0].text).not.toBe("different output");
  });
});

describe("sizeMessages", () => {
  it("counts hidden fields (thinking blocks), not just visible text", () => {
    // Two messages with identical visible .text but different hidden content.
    // sizeMessages must count the full serialized weight so all reclaim
    // mechanisms (stub-replace, error-purge, chain-range-prune) register correctly.
    const withThinking = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(1000) },
        { type: "text", text: "hello" },
      ],
    }];
    const withoutThinking = [{
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
      ],
    }];
    expect(sizeMessages(withThinking)).toBeGreaterThan(sizeMessages(withoutThinking));
  });
});

describe("pruneMessages beforeChars/afterChars", () => {
  it("no-op returns {0,0} sentinel and pruned false (no serialization on no-op path)", () => {
    const indexer = makeMockIndexer();
    // Non-empty input: a reverted fix that recomputes sizeMessages(messages)
    // on the unconditional path would yield a nonzero beforeChars here and fail.
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const result = pruneMessages(messages, indexer);
    expect(result.pruned).toBe(false);
    expect(result.beforeChars).toBe(0);
    expect(result.afterChars).toBe(0);
    // No-op returns the original array reference unchanged.
    expect(result.messages).toBe(messages);
  });

  it("pruning path: beforeChars > afterChars when stubs shrink content", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      shortRefs: new Map([["tc1", "t1"]]),
    });
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "x".repeat(500) }],
        isError: false,
        timestamp: 1,
      },
    ];
    const result = pruneMessages(messages, indexer);
    expect(result.pruned).toBe(true);
    expect(result.beforeChars).toBe(sizeMessages(messages));
    expect(result.afterChars).toBe(sizeMessages(result.messages));
    expect(result.afterChars).toBeLessThan(result.beforeChars);
    expect(result.messages).toHaveLength(2);
  });
});

describe("G4/C3: orphan-sweep zero-fire proof across pruner fixtures", () => {
  // Wraps a representative set of existing pruneMessages fixtures with a
  // counting DiagnosticSink (pruneWithZeroSweepAssertion, src/test-support.ts)
  // and fails if the orphan-sweep diagnostic ever fires. Deliberately excludes
  // the two tests in "orphan sweep in pruneMessages" above that construct an
  // orphan on purpose - those pin the OPPOSITE contract (the sweep firing when
  // it should).
  const fixtures: Array<[string, () => void]> = [
    ["stub-replaces a summarized tool result", () => {
      const indexer = makeMockIndexer({ summarized: new Set(["tc1"]), shortRefs: new Map([["tc1", "t1"]]) });
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", input: {} }], timestamp: 0 },
        { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "big output" }], isError: false, timestamp: 1 },
      ];
      pruneWithZeroSweepAssertion(messages, indexer);
    }],
    ["applies chain compression after stub-replace", () => {
      const toolCallId = "tc-mid";
      const chainEntry: ChainCompressionEntry = {
        blockId: "b1", startUserTimestamp: 100, droppedToolCallIds: [toolCallId],
        finalAssistantTimestamp: 300, toolRefs: ["t1"], compressedAt: 999,
      };
      const indexer = makeMockIndexer({
        summarized: new Set([toolCallId]), shortRefs: new Map([[toolCallId, "t1"]]),
        chainEntries: [chainEntry], summaryBodyMap: new Map([[toolCallId, "ran bash, got results"]]),
      });
      const messages: any[] = [
        { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 100 },
        { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }], timestamp: 200, usage: {}, stopReason: "tool_use" },
        { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: 210 },
        { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 300, usage: {}, stopReason: "end_turn" },
      ];
      pruneWithZeroSweepAssertion(messages, indexer, enabledCC);
    }],
    ["purges errored toolCall args through errorPurge wiring", () => {
      const indexer = makeMockIndexer();
      const largeArgs = { content: "x".repeat(200) };
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "tc-err", name: "write", arguments: largeArgs }], timestamp: 100, usage: {}, stopReason: "tool_use" },
        { role: "toolResult", toolCallId: "tc-err", toolName: "write", content: [{ type: "text", text: "Error: permission denied" }], isError: true, timestamp: 110 },
        { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { cmd: "ls" } }], timestamp: 200, usage: {}, stopReason: "tool_use" },
        { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 210 },
      ];
      pruneWithZeroSweepAssertion(
        messages, indexer,
        { enabled: false, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: false },
        { enabled: true, cooldownTurns: 2, minArgChars: 100 },
      );
    }],
    ["legacy bare-id records still stub (pre-upgrade sessions)", () => {
      const idx = new ToolCallIndexer();
      idx.reconstructFromSession({
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: CUSTOM_TYPE_INDEX, data: { toolCalls: [{ toolCallId: "bash_7", toolName: "bash", args: {}, resultText: "OLD", isError: false, turnIndex: 0, timestamp: 500 }] } },
            { type: "message", message: { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 550 } },
          ],
        },
      } as any);
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "bash_7", name: "bash", input: {} }], timestamp: 500 },
        { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 550 },
      ];
      pruneWithZeroSweepAssertion(messages, idx);
    }],
    ["occurrence-keyed: stubs the summarized occurrence and leaves the live one verbatim", () => {
      const idx = new ToolCallIndexer();
      idx.addBatch(
        { turnIndex: 0, timestamp: 1000, assistantText: "", toolCalls: [{ toolCallId: "bash_23", toolName: "bash", args: {}, resultText: "OLD", isError: false, resultTimestamp: 1150 }] } as any,
        () => {},
      );
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 1100 },
        { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 1150 },
        { role: "assistant", content: [{ type: "toolCall", id: "bash_23", name: "bash", input: {} }], timestamp: 3100 },
        { role: "toolResult", toolCallId: "bash_23", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 3150 },
      ];
      pruneWithZeroSweepAssertion(messages, idx);
    }],
    ["G1 conformance fixture: the accepted pre-upgrade legacy collision case still triggers no orphan sweep", () => {
      const idx = new ToolCallIndexer();
      idx.reconstructFromSession({
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: CUSTOM_TYPE_INDEX, data: { toolCalls: [{ toolCallId: "bash_7", toolName: "bash", args: {}, resultText: "OLD", isError: false, turnIndex: 0, timestamp: 500 }] } },
            { type: "message", message: { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "OLD" }], isError: false, timestamp: 550 } },
            { type: "message", message: { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 9150 } },
          ],
        },
      } as any);
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "bash_7", name: "bash", input: {} }], timestamp: 9100 },
        { role: "toolResult", toolCallId: "bash_7", toolName: "bash", content: [{ type: "text", text: "LIVE" }], isError: false, timestamp: 9150 },
      ];
      pruneWithZeroSweepAssertion(messages, idx);
    }],
    ["spill mechanical stub for a spilled record", () => {
      const indexer = makeMockIndexer({
        summarized: new Set(["tc1"]),
        records: new Map([["tc1", {
          toolCallId: "tc1", toolName: "fetch", args: { url: "https://x" },
          resultText: "", resultPreview: "PREVIEW-HEAD", spillPath: "/blobs/tc1.txt",
          spillBytes: 1048576, isError: false, turnIndex: 0, timestamp: 1,
        }]]),
      });
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "fetch", input: {} }], timestamp: 0 },
        { role: "toolResult", toolCallId: "tc1", toolName: "fetch", content: [{ type: "text", text: "huge" }], isError: false, timestamp: 1 },
      ];
      pruneWithZeroSweepAssertion(messages, indexer);
    }],
  ];

  for (const [name, run] of fixtures) {
    it(`zero orphan sweeps: ${name}`, run);
  }
});
