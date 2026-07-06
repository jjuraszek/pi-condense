import { describe, expect, it } from "bun:test";
import { pruneMessages, sizeMessages } from "./pruner.js";
import type { ChainCompressionConfig, ChainCompressionEntry } from "./types.js";

// Minimal mock exposing only the ToolCallIndexer surface that pruneMessages calls.
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
    expect(out[0].content[0].text).toContain("`t1`");
    expect(out[0].content[0].text).toContain("context_tree_query");
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
    const messages = [{ role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 }];
    const { messages: out } = pruneMessages(messages, indexer);
    const text = out[0].content[0].text as string;
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
    const messages = [{
      role: "toolResult", toolCallId: "tc1", toolName: "fetch",
      content: [{ type: "text", text: "huge" }], isError: false, timestamp: 1,
    }];
    const { messages: out, pruned } = pruneMessages(messages, indexer);
    expect(pruned).toBe(true);
    const text = out[0].content[0].text as string;
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

  it("composes stub-replace (Phase 1) with thinking-strip (Phase 4)", () => {
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
    const { messages: out, pruned } = pruneMessages(messages, indexer, undefined, undefined, {
      enabled: true,
      keepLastTurns: 2,
    });
    expect(pruned).toBe(true);

    // Phase 1: c10 toolResult stub-replaced
    const tr = out.find((m: any) => m.role === "toolResult" && m.toolCallId === "c10") as any;
    expect(tr.content[0].text).toContain("`t1`");

    // Phase 4: oldest 3 assistant turns stripped, last 2 keep thinking
    const assistants = out.filter((m: any) => m.role === "assistant");
    const hasThinking = (m: any) => m.content.some((c: any) => c.type === "thinking");
    expect(assistants.slice(0, 3).every((a: any) => !hasThinking(a))).toBe(true);
    expect(assistants.slice(-2).every((a: any) => hasThinking(a))).toBe(true);
  });
});

describe("render-time protection re-check", () => {
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
      [skillMsg], indexer as any, undefined, undefined, undefined,
      { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] },
    );
    expect(pruned).toBe(false);
    expect(messages[0].content[0].text).toBe("FULL SKILL BODY");
  });

  it("still stubs when no protection config is passed", () => {
    const { messages, pruned } = pruneMessages([skillMsg], indexer as any);
    expect(pruned).toBe(true);
    expect(messages[0].content[0].text).toContain("context_tree_query");
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

  it("renders a context_tree_query recovery output verbatim at age 0 within grace", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages = [mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 3);
    expect(out[0].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("stubs a context_tree_query recovery output aged past the grace window", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages: any[] = [mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 3);
    const tr = out.find((m: any) => m.toolCallId === "tc-recover") as any;
    expect(tr.content[0].text).toContain("context_tree_query");
    expect(tr.content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
  });

  it("stubs at age 0 when recoveryGraceTurns is 0 (feature off)", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-recover"]),
      shortRefs: new Map([["tc-recover", "t1"]]),
    });
    const messages = [mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 0);
    expect(out[0].content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(out[0].content[0].text).toContain("context_tree_query");
  });

  it("does not apply the grace window to non-context_tree_query outputs", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc-bash"]),
      shortRefs: new Map([["tc-bash", "t1"]]),
    });
    const messages = [
      {
        role: "toolResult",
        toolCallId: "tc-bash",
        toolName: "bash",
        content: [{ type: "text", text: "VERBATIM RECOVERY OUTPUT" }],
        isError: false,
        timestamp: 1,
      },
    ];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 3);
    expect(out[0].content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(out[0].content[0].text).toContain("context_tree_query");
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
    const messages: any[] = [mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(
      messages, indexer, undefined, undefined, undefined,
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
    const messages = [mkQueryResult("tc-recover", 1)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 3);
    expect(out[0].content[0].text).toBe("VERBATIM RECOVERY OUTPUT");
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
    const messages: any[] = [mkQueryResult("tc-recover", 1), mkUser(2), mkUser(3), mkUser(4), mkUser(5)];
    const { messages: out } = pruneMessages(messages, indexer, undefined, undefined, undefined, undefined, 3);
    const tr = out.find((m: any) => m.toolCallId === "tc-recover") as any;
    expect(tr.content[0].text).not.toBe("VERBATIM RECOVERY OUTPUT");
    expect(tr.content[0].text).toContain("/blobs/tc-recover.txt");
    expect(tr.content[0].text).toContain("spilled");
  });
});

describe("sizeMessages", () => {
  it("counts hidden fields (thinking blocks), not just visible text", () => {
    // Two messages with identical visible .text but different hidden content.
    // sizeMessages must count the full serialized weight so all reclaim
    // mechanisms (thinking-strip, error-purge, etc.) register correctly.
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
  it("no-op fast path: beforeChars === afterChars === sizeMessages(input) and pruned false", () => {
    const indexer = makeMockIndexer();
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const result = pruneMessages(messages, indexer);
    expect(result.pruned).toBe(false);
    const expected = sizeMessages(messages);
    expect(result.beforeChars).toBe(expected);
    expect(result.afterChars).toBe(expected);
  });

  it("pruning path: beforeChars > afterChars when stubs shrink content", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      shortRefs: new Map([["tc1", "t1"]]),
    });
    const messages = [
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
  });
});
