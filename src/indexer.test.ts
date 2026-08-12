import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY, CUSTOM_TYPE_DEDUP_ALIAS } from "./types.js";
import type { CapturedBatch } from "./types.js";

const batch = (
  turnIndex: number,
  timestamp: number,
  calls: { id: string; ts?: number; text: string }[],
): CapturedBatch => ({
  turnIndex,
  timestamp,
  assistantText: "",
  toolCalls: calls.map((c) => ({
    toolCallId: c.id,
    toolName: "bash",
    args: { cmd: "ls" },
    resultText: c.text,
    isError: false,
    ...(c.ts !== undefined ? { resultTimestamp: c.ts } : {}),
  })),
});

describe("occurrence keying", () => {
  test("two batches reusing one provider id keep both records", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});
    indexer.addBatch(batch(1, 2000, [{ id: "bash_23", ts: 2150, text: "SECOND" }]), () => {});

    expect(indexer.getRecord("bash_23@1150")?.resultText).toBe("FIRST");
    expect(indexer.getRecord("bash_23@2150")?.resultText).toBe("SECOND");
  });

  test("isSummarized is keyed by occurrence, so a live reused id is not summarized", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});

    expect(indexer.isSummarized("bash_23@1150")).toBe(true);
    expect(indexer.isSummarized("bash_23@3150")).toBe(false);
  });

  test("getRecordsForId returns every occurrence of a bare id, chronologically", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 2000, [{ id: "bash_23", ts: 2150, text: "SECOND" }]), () => {});
    indexer.addBatch(batch(1, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});

    const records = indexer.getRecordsForId("bash_23");
    expect(records.map((r) => r.resultText)).toEqual(["FIRST", "SECOND"]);
  });

  test("getRecordsForId on an occurrence key or short ref returns exactly one", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});
    indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 }]);

    expect(indexer.getRecordsForId("bash_23@1150").map((r) => r.resultText)).toEqual(["FIRST"]);
    expect(indexer.getRecordsForId("t1").map((r) => r.resultText)).toEqual(["FIRST"]);
  });

  test("short refs resolve per occurrence", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});
    indexer.addBatch(batch(1, 2000, [{ id: "bash_23", ts: 2150, text: "SECOND" }]), () => {});
    indexer.registerSummaryRefs([
      { shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 },
      { shortId: "t2", toolCallId: "bash_23", resultTimestamp: 2150 },
    ]);

    expect(indexer.getRecord("t1")?.resultText).toBe("FIRST");
    expect(indexer.getRecord("t2")?.resultText).toBe("SECOND");
    expect(indexer.getShortRefForToolCallId("bash_23@2150")).toBe("t2");
  });

  test("allocateSummaryRefs mints refs carrying the occurrence timestamp", () => {
    const indexer = new ToolCallIndexer();
    const b = batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]);
    const refs = indexer.allocateSummaryRefs(b);

    expect(refs).toEqual([{ shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 }]);
  });

  test("content dedup does not alias across batches that merely share an id", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});
    indexer.addBatch(batch(1, 2000, [{ id: "bash_23", ts: 2150, text: "SECOND" }]), () => {});

    // Each occurrence's content resolves to its OWN occurrence key, never
    // to the other occurrence merely because they share a bare id.
    expect(indexer.lookupByContent("bash", "FIRST")).toBe("bash_23@1150");
    expect(indexer.lookupByContent("bash", "SECOND")).toBe("bash_23@2150");
    expect(indexer.lookupByContent("bash", "UNSEEN")).toBeUndefined();
  });

  test("registerDuplicate persists both occurrence sides and reuses the short ref", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "SAME" }]), () => {});
    indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 }]);

    let persisted: any;
    indexer.registerDuplicate("bash_99@4150", "bash_23@1150", (customType, data) => {
      persisted = { customType, data };
    });

    expect(persisted).toEqual({
      customType: CUSTOM_TYPE_DEDUP_ALIAS,
      data: {
        newToolCallId: "bash_99",
        newResultTimestamp: 4150,
        originalToolCallId: "bash_23",
        originalResultTimestamp: 1150,
      },
    });
    expect(indexer.isSummarized("bash_99@4150")).toBe(true);
    expect(indexer.getRecord("bash_99@4150")?.resultText).toBe("SAME");
    expect(indexer.getShortRefForToolCallId("bash_99@4150")).toBe("t1");
  });

  test("getRecordsForId includes a dedup-alias occurrence, labelled with its own timestamp", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "SAME" }]), () => {});
    // Alias shares the SAME bare id as the original but occurred later - the
    // G5 conformance shape: a content-deduplicated collision on a reused id.
    indexer.registerDuplicate("bash_23@9150", "bash_23@1150", () => {});

    const records = indexer.getRecordsForId("bash_23");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.resultText)).toEqual(["SAME", "SAME"]);
    expect(records.map((r) => r.resultTimestamp)).toEqual([1150, 9150]);
  });

  test("summary body lookups are occurrence-keyed", () => {
    const indexer = new ToolCallIndexer();
    indexer.registerSummaryBody(["bash_23@1150"], "summary of FIRST");

    expect(indexer.hasPerBatchSummaryCoveringAny(["bash_23@1150"])).toBe(true);
    expect(indexer.hasPerBatchSummaryCoveringAny(["bash_23@3150"])).toBe(false);
    expect(indexer.getPerBatchSummaryTextForToolCallIds(["bash_23@1150"])).toBe("summary of FIRST");
  });
});

describe("fail-closed asymmetry: isSummarized vs bare-id resolution", () => {
  test("single occurrence: isSummarized on the bare id is strict-false, resolveToolCallId/getRecord fall back", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});

    expect(indexer.isSummarized("bash_23")).toBe(false);
    expect(indexer.resolveToolCallId("bash_23")).toBe("bash_23@1150");
    expect(indexer.getRecord("bash_23")?.resultText).toBe("FIRST");
  });

  test("two occurrences: resolveToolCallId on the bare id is ambiguous, getRecordsForId expands both", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", ts: 1150, text: "FIRST" }]), () => {});
    indexer.addBatch(batch(1, 2000, [{ id: "bash_23", ts: 2150, text: "SECOND" }]), () => {});

    expect(indexer.resolveToolCallId("bash_23")).toBeUndefined();
    expect(indexer.getRecordsForId("bash_23").map((r) => r.resultText)).toEqual(["FIRST", "SECOND"]);
  });

  test("mixed legacy + new occurrence under the same bare id: hasLegacyBareRecord is false (fail-closed), getRecordsForId returns both", () => {
    const indexer = new ToolCallIndexer();
    indexer.addBatch(batch(0, 1000, [{ id: "bash_23", text: "OLD" }]), () => {});
    indexer.addBatch(batch(1, 2000, [{ id: "bash_23", ts: 2150, text: "NEW" }]), () => {});

    // A mixed bare+occurrence id must fail closed: the pruner's legacy-bare
    // path would otherwise stub an unrelated live occurrence with the stale
    // legacy record (F1 regression - see pruner.test.ts).
    expect(indexer.hasLegacyBareRecord("bash_23")).toBe(false);
    expect(indexer.getRecordsForId("bash_23").map((r) => r.resultText)).toEqual(["OLD", "NEW"]);
  });

  test("hasLegacyBareRecord: true for pure-legacy, false for pure-occurrence, false for mixed", () => {
    const legacyOnly = new ToolCallIndexer();
    legacyOnly.addBatch(batch(0, 1000, [{ id: "bash_1", text: "OLD" }]), () => {});
    expect(legacyOnly.hasLegacyBareRecord("bash_1")).toBe(true);

    const occOnly = new ToolCallIndexer();
    occOnly.addBatch(batch(0, 1000, [{ id: "bash_2", ts: 1150, text: "NEW" }]), () => {});
    expect(occOnly.hasLegacyBareRecord("bash_2")).toBe(false);

    const mixed = new ToolCallIndexer();
    mixed.addBatch(batch(0, 1000, [{ id: "bash_3", text: "OLD" }]), () => {});
    mixed.addBatch(batch(1, 2000, [{ id: "bash_3", ts: 2150, text: "NEW" }]), () => {});
    expect(mixed.hasLegacyBareRecord("bash_3")).toBe(false);
  });

  test("rebuild is order-independent: a dedup alias entry appearing BEFORE its summary entry still inherits the short ref", () => {
    const indexEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_INDEX,
      data: {
        toolCalls: [
          {
            toolCallId: "bash_23",
            toolName: "bash",
            args: {},
            resultText: "FIRST",
            isError: false,
            turnIndex: 0,
            timestamp: 1000,
            resultTimestamp: 1150,
          },
        ],
      },
    };
    const dedupEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_DEDUP_ALIAS,
      data: {
        newToolCallId: "bash_99",
        newResultTimestamp: 4150,
        originalToolCallId: "bash_23",
        originalResultTimestamp: 1150,
      },
    };
    const summaryEntry = {
      type: "custom_message",
      customType: CUSTOM_TYPE_SUMMARY,
      content: "summary text",
      details: {
        toolCallRefs: [{ shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 }],
        toolNames: ["bash"],
        turnIndex: 0,
        timestamp: 1000,
      },
    };

    const indexer = new ToolCallIndexer();
    // dedup entry appears BEFORE the summary entry in the branch, unlike every other test here.
    const ctx = { sessionManager: { getBranch: () => [indexEntry, dedupEntry, summaryEntry] } } as any;
    indexer.reconstructFromSession(ctx);

    expect(indexer.getShortRefForToolCallId("bash_99@4150")).toBe("t1");
  });
});

describe("session rebuild", () => {
  test("rebuilds occurrence records, both short refs and the dedup alias", () => {
    const indexEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_INDEX,
      data: {
        toolCalls: [
          {
            toolCallId: "bash_23",
            toolName: "bash",
            args: {},
            resultText: "FIRST",
            isError: false,
            turnIndex: 0,
            timestamp: 1000,
            resultTimestamp: 1150,
          },
          {
            toolCallId: "bash_23",
            toolName: "bash",
            args: {},
            resultText: "SECOND",
            isError: false,
            turnIndex: 1,
            timestamp: 2000,
            resultTimestamp: 2150,
          },
        ],
      },
    };
    const summaryEntry = {
      type: "custom_message",
      customType: CUSTOM_TYPE_SUMMARY,
      content: "summary text",
      details: {
        toolCallRefs: [
          { shortId: "t1", toolCallId: "bash_23", resultTimestamp: 1150 },
          { shortId: "t2", toolCallId: "bash_23", resultTimestamp: 2150 },
        ],
        toolNames: ["bash", "bash"],
        turnIndex: 1,
        timestamp: 2000,
      },
    };
    const dedupEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_DEDUP_ALIAS,
      data: {
        newToolCallId: "bash_99",
        newResultTimestamp: 4150,
        originalToolCallId: "bash_23",
        originalResultTimestamp: 1150,
      },
    };

    const indexer = new ToolCallIndexer();
    const ctx = { sessionManager: { getBranch: () => [indexEntry, summaryEntry, dedupEntry] } } as any;
    indexer.reconstructFromSession(ctx);

    expect(indexer.getRecord("t1")?.resultText).toBe("FIRST");
    expect(indexer.getRecord("t2")?.resultText).toBe("SECOND");
    expect(indexer.getRecord("bash_99@4150")?.resultText).toBe("FIRST");
    expect(indexer.getShortRefForToolCallId("bash_99@4150")).toBe("t1");
    expect(indexer.getPerBatchSummaryTextForToolCallIds(["bash_23@2150"])).toBe("summary text");
  });

  test("legacy entries without resultTimestamp keep bare-id keys", () => {
    const indexEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_INDEX,
      data: {
        toolCalls: [
          {
            toolCallId: "bash_7",
            toolName: "bash",
            args: {},
            resultText: "OLD",
            isError: false,
            turnIndex: 0,
            timestamp: 1000,
          },
        ],
      },
    };
    const legacyDedupEntry = {
      type: "custom",
      customType: CUSTOM_TYPE_DEDUP_ALIAS,
      data: { newToolCallId: "bash_8", originalToolCallId: "bash_7" },
    };

    const indexer = new ToolCallIndexer();
    const ctx = { sessionManager: { getBranch: () => [indexEntry, legacyDedupEntry] } } as any;
    indexer.reconstructFromSession(ctx);

    expect(indexer.getRecord("bash_7")?.resultText).toBe("OLD");
    expect(indexer.hasLegacyBareRecord("bash_7")).toBe(true);
    expect(indexer.hasLegacyBareRecord("bash_23")).toBe(false);
    expect(indexer.isSummarized("bash_8")).toBe(true);
  });
});
