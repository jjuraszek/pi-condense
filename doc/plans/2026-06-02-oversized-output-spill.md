# Oversized tool-result spill + budget-delta flush — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Stop a single huge tool result from dominating the context window by (A) spilling any oversized result to a sidecar file and stubbing it immediately, and (B) forcing a flush when one turn's usage jumps by a configurable fraction.

**Architecture:** Pure fs/path/preview helpers live in a new `src/spill.ts`; the eager-spill orchestration runs synchronously in the `turn_end` handler (after the existing protected-tool filter, before `flushPending`), reusing `Indexer.addBatch`/`registerDuplicate` so the spilled record becomes `isSummarized` and `pruneMessages` stubs it on the next `context` build — no LLM call. Budget-delta is a second flush trigger in `turn_end` alongside the existing absolute `shouldBudgetFlush`, backed by a pure `shouldDeltaFlush` and a module-level `previousFraction`.

**Tech Stack:** TypeScript (NodeNext), `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` peer deps, `bun test` (`bun:test`).

**Spec:** `doc/specs/2026-06-02-oversized-output-spill.md`

**Linear:** none

---

## Notes / deviations from spec prose

- **Spilled record body.** A spilled `ToolCallRecord` persists `resultText = ""` (not the full body) plus `resultPreview` (head preview), `spillPath`, `spillBytes`, `contentHash`. The empty `resultText` is deliberate: the dedup map must NOT hash an empty string for spilled records (all would collide), so reconstruct/addBatch use the persisted `contentHash` instead. The full body lives only in the sidecar file.
- **Stub line count.** The spec mentions "spillBytes + line count" in the stub. Line count is **omitted** (not persisted) to avoid carrying a cosmetic field; the stub shows `spillBytes` + the head preview, which already conveys structure. Minor, intentional.
- **No short ref for eager-spilled records.** `tN` short refs are allocated only by the summarizer flush (`allocateSummaryRefs`). Eager spill uses `addBatch` directly, so a spilled record has no `tN`; the stub and `context_tree_query` use the full `toolCallId`, which `resolveToolCallId` resolves via `index.has(...)`.
- **`src/batch-capture.ts` is NOT modified.** The spec's touched-files table attributed the spill orchestration there; in practice the protected filter already lives in `index.ts` `turn_end`, so the orchestration is wired there and the pure helpers live in `src/spill.ts`. `batch-capture.ts` is untouched.

## Files

**Create:**
- `src/spill.ts`
- `src/spill.test.ts`

**Modify:**
- `src/types.ts` (`ToolCallRecord` + `CapturedToolCall` optional fields; `ContextPruneConfig` + `DEFAULT_CONFIG` 3 new keys)
- `src/budget.ts` (`usageFraction`, `shouldDeltaFlush`)
- `src/budget.test.ts` (tests for the two new functions)
- `src/config.ts` (`normalize`: parse `spillThreshold`, `spillPreviewBytes`, `budgetTurnDelta`)
- `src/indexer.ts` (`addBatch` copies spill fields + uses persisted `contentHash`; `reconstructFromSession` uses persisted `contentHash`)
- `src/pruner.ts` (Phase 1: branch on `record.spillPath`)
- `src/pruner.test.ts` (mock indexer gains `getRecord`; spill-stub test)
- `src/query-tool.ts` (read sidecar file when `spillPath` set; fall back to `resultPreview`)
- `index.ts` (`turn_end`: eager spill + budget-delta; `session_start`/`session_tree`: reset `previousFraction`)
- `README.md` (3 new settings + read-the-blob recovery)
- `PRUNING.md` (eager-spill layer + budget-delta trigger)

**Delete:** none

---

## Wave 1 — Foundations

Parallel-safe: Tasks 1–2 own disjoint files (`src/types.ts` vs. `src/budget.ts` + `src/budget.test.ts`) and have no ordering dependency.

### Task 1: Type + config fields

**TDD scenario:** Type/constant declarations — no standalone test; exercised by every downstream task and the typecheck gate.

**Files:**
- Modify: `src/types.ts` (`ToolCallRecord` ~491-501; `CapturedToolCall` ~456-462; `ContextPruneConfig` ~311 region; `DEFAULT_CONFIG` ~424-451)

- [ ] **Step 1: Extend `ToolCallRecord`**

  In `src/types.ts`, add optional fields to `ToolCallRecord` (after `timestamp`):

  ```ts
  export interface ToolCallRecord {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    /** Full original result text. Empty ("") for spilled records — body lives in the sidecar file at spillPath. */
    resultText: string;
    isError: boolean;
    turnIndex: number;
    timestamp: number;
    /** Absolute path to the sidecar blob holding the full body (set only when the result was spilled). */
    spillPath?: string;
    /** Full byte length of the spilled body. */
    spillBytes?: number;
    /** Head preview kept inline when spilled (resultText is "" in that case). */
    resultPreview?: string;
    /** Dedup hash of the FULL body, persisted so reconstruct/addBatch skip rehashing the empty resultText. */
    contentHash?: string;
  }
  ```

- [ ] **Step 2: Extend `CapturedToolCall`**

  Add the same optional spill fields so the orchestration can hand them to `addBatch`:

  ```ts
  export interface CapturedToolCall {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    resultText: string;
    isError: boolean;
    spillPath?: string;
    spillBytes?: number;
    resultPreview?: string;
    contentHash?: string;
  }
  ```

- [ ] **Step 3: Add config fields to `ContextPruneConfig`**

  After `autoBudgetThreshold: number | null;` in `ContextPruneConfig`, add:

  ```ts
    /** Min chars (resultText.length) for a single tool result to spill to a sidecar file. */
    spillThreshold: number;
    /** Head-preview size in bytes kept inline as resultPreview on a spilled record. */
    spillPreviewBytes: number;
    /**
     * Per-turn usage-fraction increase (0–1) that forces a flush, independent of
     * autoBudgetThreshold. null (default) = disabled. Out-of-range (<= 0 or > 1) normalizes to null.
     */
    budgetTurnDelta: number | null;
  ```

- [ ] **Step 4: Add defaults to `DEFAULT_CONFIG`**

  After `autoBudgetThreshold: null,`:

  ```ts
    spillThreshold: 65536,
    spillPreviewBytes: 2048,
    budgetTurnDelta: null,
  ```

- [ ] **Step 5: Typecheck**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
  Expected: PASS (no new errors).

- [ ] **Step 6: Commit**

  ```bash
  git add src/types.ts
  git commit -m "types: add spill fields + spillThreshold/spillPreviewBytes/budgetTurnDelta config"
  ```

### Task 2: `shouldDeltaFlush` + `usageFraction`

**TDD scenario:** New pure functions — full TDD cycle.

**Files:**
- Modify: `src/budget.ts`
- Test: `src/budget.test.ts`

- [ ] **Step 1: Write failing tests**

  Append to `src/budget.test.ts`:

  ```ts
  import { shouldDeltaFlush, usageFraction } from "./budget.js";

  describe("usageFraction", () => {
    it("returns null for undefined / null tokens / non-positive window", () => {
      expect(usageFraction(undefined)).toBeNull();
      expect(usageFraction(usage(null, 1000))).toBeNull();
      expect(usageFraction(usage(900, 0))).toBeNull();
    });
    it("returns the 0–1 fraction", () => {
      expect(usageFraction(usage(750, 1000))).toBe(0.75);
    });
  });

  describe("shouldDeltaFlush", () => {
    it("is false when delta is null or non-positive", () => {
      expect(shouldDeltaFlush(usage(900, 1000), 0.5, null)).toBe(false);
      expect(shouldDeltaFlush(usage(900, 1000), 0.5, 0)).toBe(false);
    });
    it("is false when previousFraction is null (first turn / post-restart)", () => {
      expect(shouldDeltaFlush(usage(900, 1000), null, 0.15)).toBe(false);
    });
    it("is false when usage missing or tokens null", () => {
      expect(shouldDeltaFlush(undefined, 0.5, 0.15)).toBe(false);
      expect(shouldDeltaFlush(usage(null, 1000), 0.5, 0.15)).toBe(false);
    });
    it("fires when the jump meets the delta, not below", () => {
      expect(shouldDeltaFlush(usage(700, 1000), 0.5, 0.15)).toBe(true);  // 0.20 >= 0.15
      expect(shouldDeltaFlush(usage(650, 1000), 0.5, 0.15)).toBe(true);  // 0.15 exactly
      expect(shouldDeltaFlush(usage(640, 1000), 0.5, 0.15)).toBe(false); // 0.14 < 0.15
      expect(shouldDeltaFlush(usage(600, 1000), 0.5, 0.15)).toBe(false); // 0.10 < 0.15
    });
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `bun test src/budget.test.ts`
  Expected: FAIL — `shouldDeltaFlush`/`usageFraction` are not exported.

- [ ] **Step 3: Implement**

  Append to `src/budget.ts`:

  ```ts
  /** 0–1 usage fraction, or null when usage is missing / tokens null / window non-positive. */
  export function usageFraction(usage: ContextUsage | undefined): number | null {
    if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return null;
    return usage.tokens / usage.contextWindow;
  }

  /**
   * True iff this turn's usage fraction rose by at least `delta` versus the previous
   * turn. Mirrors shouldBudgetFlush's guards. previousFraction === null (first turn or
   * post-restart) never fires; the absolute autoBudgetThreshold covers that gap.
   */
  export function shouldDeltaFlush(
    usage: ContextUsage | undefined,
    previousFraction: number | null,
    delta: number | null,
  ): boolean {
    if (delta == null || delta <= 0 || delta > 1) return false;
    if (previousFraction == null) return false;
    const current = usageFraction(usage);
    if (current == null) return false;
    return current - previousFraction >= delta;
  }
  ```

- [ ] **Step 4: Run, confirm pass**

  Run: `bun test src/budget.test.ts`
  Expected: PASS (all cases, including the corrected `0.64` → false).

- [ ] **Step 5: Commit**

  ```bash
  git add src/budget.ts src/budget.test.ts
  git commit -m "budget: add usageFraction + shouldDeltaFlush (per-turn delta trigger)"
  ```

---

## Wave 2 — Consumers of the new types

Depends on Wave 1 Task 1 (the new `ToolCallRecord` / `CapturedToolCall` / config fields).
Parallel-safe: Tasks 3–6 own disjoint files (`src/config.ts`; `src/indexer.ts`; `src/pruner.ts` + `src/pruner.test.ts`; `src/query-tool.ts`). None depends on another in this wave.

### Task 3: Parse the 3 new config fields

**TDD scenario:** Modifying tested code — no `config.test.ts` exists; guard via typecheck + the integration test in Wave 5. Keep the change mechanical.

**Files:**
- Modify: `src/config.ts` (`normalize`, after the `autoBudgetThreshold` block ~59-65)

- [ ] **Step 1: Add normalization branches**

  Inside the returned object in `normalize`, after the `autoBudgetThreshold` entry, add:

  ```ts
    spillThreshold:
      typeof merged.spillThreshold === "number" &&
      Number.isFinite(merged.spillThreshold) &&
      merged.spillThreshold > 0
        ? Math.floor(merged.spillThreshold)
        : DEFAULT_CONFIG.spillThreshold,
    spillPreviewBytes:
      typeof merged.spillPreviewBytes === "number" &&
      Number.isFinite(merged.spillPreviewBytes) &&
      merged.spillPreviewBytes >= 0
        ? Math.floor(merged.spillPreviewBytes)
        : DEFAULT_CONFIG.spillPreviewBytes,
    budgetTurnDelta:
      typeof merged.budgetTurnDelta === "number" &&
      Number.isFinite(merged.budgetTurnDelta) &&
      merged.budgetTurnDelta > 0 &&
      merged.budgetTurnDelta <= 1
        ? merged.budgetTurnDelta
        : DEFAULT_CONFIG.budgetTurnDelta,
  ```

- [ ] **Step 2: Typecheck**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
  Expected: PASS.

- [ ] **Step 3: Commit**

  ```bash
  git add src/config.ts
  git commit -m "config: normalize spillThreshold/spillPreviewBytes/budgetTurnDelta"
  ```

### Task 4: Indexer carries spill fields + persisted contentHash

**TDD scenario:** Modifying tested code — exercised by Wave 5 integration; keep edits surgical and typecheck.

**Files:**
- Modify: `src/indexer.ts` (`reconstructFromSession` hash line ~76-79; `addBatch` record build ~ end of file)

- [ ] **Step 1: Use persisted `contentHash` in `reconstructFromSession`**

  In `reconstructFromSession`, replace the hash computation inside the `CUSTOM_TYPE_INDEX` loop:

  ```ts
  // before:
  const hash = hashToolResult(toolCall.toolName, toolCall.resultText);
  // after:
  const hash = toolCall.contentHash ?? hashToolResult(toolCall.toolName, toolCall.resultText);
  ```

  (Spilled records have `resultText === ""`; using the persisted `contentHash` keeps dedup correct and avoids all spilled records colliding on `hash("")`.)

- [ ] **Step 2: Carry spill fields + persisted hash in `addBatch`**

  In `addBatch`, build the record copying the optional fields and prefer `tc.contentHash`:

  ```ts
  for (const tc of batch.toolCalls) {
    const record: ToolCallRecord = {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      isError: tc.isError,
      turnIndex: batch.turnIndex,
      timestamp: batch.timestamp,
      ...(tc.spillPath !== undefined ? { spillPath: tc.spillPath } : {}),
      ...(tc.spillBytes !== undefined ? { spillBytes: tc.spillBytes } : {}),
      ...(tc.resultPreview !== undefined ? { resultPreview: tc.resultPreview } : {}),
      ...(tc.contentHash !== undefined ? { contentHash: tc.contentHash } : {}),
    };
    this.index.set(record.toolCallId, record);
    records.push(record);
    const hash = record.contentHash ?? hashToolResult(record.toolName, record.resultText);
    if (!this.contentHashToOriginal.has(hash)) {
      this.contentHashToOriginal.set(hash, record.toolCallId);
    }
  }
  ```

- [ ] **Step 3: Typecheck**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
  Expected: PASS.

- [ ] **Step 4: Run existing indexer-touching tests**

  Run: `bun test src/`
  Expected: PASS (no regressions; spill fields are additive).

- [ ] **Step 5: Commit**

  ```bash
  git add src/indexer.ts
  git commit -m "indexer: carry spill fields and persist contentHash for spilled records"
  ```

### Task 5: Pruner stub branching on `spillPath`

**TDD scenario:** Modifying tested code — full TDD cycle for the new branch.

**Files:**
- Modify: `src/pruner.ts` (Phase 1 map ~64-83)
- Test: `src/pruner.test.ts` (mock indexer ~7-29; new test case)

- [ ] **Step 1: Write the failing test**

  In `src/pruner.test.ts`, add `getRecord` to `makeMockIndexer`'s options and returned object:

  ```ts
  // add to the options destructure:
  records = new Map<string, any>(),
  // add to the returned object:
  getRecord: (id: string) => records.get(id),
  ```

  Then add a test:

  ```ts
  it("emits a mechanical spill stub for a spilled record", () => {
    const indexer = makeMockIndexer({
      summarized: new Set(["tc1"]),
      records: new Map([["tc1", {
        toolCallId: "tc1",
        toolName: "fetch",
        args: { url: "https://x" },
        resultText: "",
        resultPreview: "PREVIEW-HEAD",
        spillPath: "/blobs/tc1.txt",
        spillBytes: 1048576,
        isError: false,
        turnIndex: 0,
        timestamp: 1,
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
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `bun test src/pruner.test.ts`
  Expected: FAIL — current stub always says "Summarized in pruner summary".

- [ ] **Step 3: Implement the branch**

  In `src/pruner.ts` Phase 1, replace the body of the `if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId))` block:

  ```ts
  if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)) {
    pruned = true;
    const ref = indexer.getShortRefForToolCallId(msg.toolCallId) ?? msg.toolCallId;
    const record = indexer.getRecord(msg.toolCallId);
    const text = record?.spillPath
      ? [
          `[Oversized output spilled to file — ${record.spillBytes ?? "?"} bytes.]`,
          `Tool: ${record.toolName}(${JSON.stringify(record.args)})`,
          `Preview (head):`,
          record.resultPreview ?? "",
          `Full output — read this file (offset/limit supported): ${record.spillPath}`,
          `Or use context_tree_query with ref \`${ref}\`.`,
        ].join("\n")
      : `[Summarized in pruner summary, ref \`${ref}\`. Use context_tree_query to retrieve full output.]`;
    return {
      role: "toolResult",
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: msg.timestamp,
    };
  }
  ```

- [ ] **Step 4: Run, confirm pass**

  Run: `bun test src/pruner.test.ts`
  Expected: PASS (new test + all existing pruner tests).

- [ ] **Step 5: Commit**

  ```bash
  git add src/pruner.ts src/pruner.test.ts
  git commit -m "pruner: mechanical spill stub when record has spillPath"
  ```

### Task 6: Query-tool reads the sidecar file

**TDD scenario:** Modifying tested code — no query-tool unit test exists; validate via typecheck + Wave 5 integration.

**Files:**
- Modify: `src/query-tool.ts` (imports; `execute` body ~46-58)

- [ ] **Step 1: Import `readFile`**

  At the top of `src/query-tool.ts`:

  ```ts
  import { readFile } from "node:fs/promises";
  ```

- [ ] **Step 2: Branch on `spillPath` before `truncateHead`**

  Replace the `const t = truncateHead(record.resultText, {...})` line with:

  ```ts
  let raw = record.resultText;
  if (record.spillPath) {
    try {
      raw = await readFile(record.spillPath, "utf-8");
    } catch {
      raw = record.resultPreview ?? "(spilled output unavailable — sidecar file missing)";
    }
  }
  const t = truncateHead(raw, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  ```

- [ ] **Step 3: Typecheck**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/query-tool.ts
  git commit -m "query-tool: read sidecar file for spilled records, fall back to preview"
  ```

---

## Wave 3 — Spill core

Depends on Wave 1 (Task 1 types) and Wave 2 (Task 4 indexer `addBatch`/`registerDuplicate`/`lookupByContent` behavior). Single task.

### Task 7: `src/spill.ts` — pure helpers + orchestration

**TDD scenario:** New module — full TDD cycle for the pure helpers; orchestration tested against a real `ToolCallIndexer` + tmp dir.

**Files:**
- Create: `src/spill.ts`
- Test: `src/spill.test.ts`

- [ ] **Step 1: Write failing tests**

  Create `src/spill.test.ts`:

  ```ts
  import { describe, it, expect } from "bun:test";
  import { mkdtemp, readFile, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { sanitizeId, blobDirFor, blobPathFor, headPreview, spillOversizedBatch } from "./spill.js";
  import { ToolCallIndexer } from "./indexer.js";
  import type { CapturedBatch } from "./types.js";

  describe("sanitizeId", () => {
    it("replaces path separators and unsafe chars", () => {
      expect(sanitizeId("toolu_abc-123")).toBe("toolu_abc-123");
      expect(sanitizeId("../../etc/passwd")).toBe("______etc_passwd");
      expect(sanitizeId("a/b\\c")).toBe("a_b_c");
    });
  });

  describe("blobDirFor / blobPathFor", () => {
    it("builds <sessionDir>/<sessionId>-blobs/<id>.txt", () => {
      expect(blobDirFor("/s", "sid")).toBe(join("/s", "sid-blobs"));
      expect(blobPathFor("/s", "sid", "tc1")).toBe(join("/s", "sid-blobs", "tc1.txt"));
    });
  });

  describe("headPreview", () => {
    it("returns the whole string when under the byte cap", () => {
      expect(headPreview("hello", 1024)).toBe("hello");
    });
    it("cuts at a line boundary when one exists in budget", () => {
      const out = headPreview("aaaa\nbbbb\ncccc", 7);
      expect(out).toBe("aaaa");
    });
    it("never exceeds the byte cap and stays valid UTF-8", () => {
      const s = "é".repeat(100); // 2 bytes each
      const out = headPreview(s, 11);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(11);
      expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow();
    });
  });

  describe("spillOversizedBatch", () => {
    const cfg = { spillThreshold: 10, spillPreviewBytes: 8, dedupByContentHash: true };
    const mkBatch = (toolCalls: any[]): CapturedBatch => ({ turnIndex: 0, timestamp: 1, assistantText: "", toolCalls });

    it("spills an oversized result: writes file, mutates record, indexes it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "spill-"));
      try {
        const indexer = new ToolCallIndexer();
        const appended: any[] = [];
        const batch = mkBatch([{ toolCallId: "tc1", toolName: "fetch", args: {}, resultText: "X".repeat(50), isError: false }]);
        const spilled = await spillOversizedBatch({
          batch, indexer, config: cfg, sessionDir: dir, sessionId: "sid",
          appendEntry: (t, d) => appended.push({ t, d }),
        });
        expect(spilled.has("tc1")).toBe(true);
        const rec = indexer.getRecord("tc1")!;
        expect(rec.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
        expect(rec.spillBytes).toBe(50);
        expect(rec.resultText).toBe("");
        expect(rec.resultPreview!.length).toBeGreaterThan(0);
        expect(await readFile(rec.spillPath!, "utf-8")).toBe("X".repeat(50));
        expect(indexer.isSummarized("tc1")).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("leaves a small result untouched (not spilled)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "spill-"));
      try {
        const indexer = new ToolCallIndexer();
        const batch = mkBatch([{ toolCallId: "tc1", toolName: "bash", args: {}, resultText: "tiny", isError: false }]);
        const spilled = await spillOversizedBatch({
          batch, indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: () => {},
        });
        expect(spilled.size).toBe(0);
        expect(indexer.isSummarized("tc1")).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("dedups an oversized duplicate to the original without a second file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "spill-"));
      try {
        const indexer = new ToolCallIndexer();
        const body = "Y".repeat(50);
        const appended: any[] = [];
        const append = (t: string, d: unknown) => appended.push({ t, d });
        await spillOversizedBatch({
          batch: mkBatch([{ toolCallId: "tc1", toolName: "fetch", args: {}, resultText: body, isError: false }]),
          indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: append,
        });
        const spilled2 = await spillOversizedBatch({
          batch: mkBatch([{ toolCallId: "tc2", toolName: "fetch", args: {}, resultText: body, isError: false }]),
          indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry: append,
        });
        expect(spilled2.has("tc2")).toBe(true);            // handled (removed from pending)
        expect(indexer.isSummarized("tc2")).toBe(true);    // via dedup alias
        expect(indexer.getRecord("tc2")!.toolCallId).toBe("tc1"); // resolves to original
        // tc2 has no own sidecar file
        await expect(readFile(blobPathFor(dir, "sid", "tc2"), "utf-8")).rejects.toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `bun test src/spill.test.ts`
  Expected: FAIL — `./spill.js` does not exist.

- [ ] **Step 3: Implement `src/spill.ts`**

  ```ts
  import { mkdir, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  import type { CapturedBatch, CapturedToolCall } from "./types.js";
  import type { ToolCallIndexer } from "./indexer.js";
  import { hashToolResult } from "./content-hash.js";

  /** Replace anything outside [A-Za-z0-9_-] so the id can't escape the blob dir. */
  export function sanitizeId(toolCallId: string): string {
    return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
  }

  export function blobDirFor(sessionDir: string, sessionId: string): string {
    return join(sessionDir, `${sessionId}-blobs`);
  }

  export function blobPathFor(sessionDir: string, sessionId: string, toolCallId: string): string {
    return join(blobDirFor(sessionDir, sessionId), `${sanitizeId(toolCallId)}.txt`);
  }

  /** Head of `text` capped at `maxBytes` (UTF-8 safe), preferring a line boundary. */
  export function headPreview(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes) return text;
    let end = maxBytes;
    // Back off mid-sequence: UTF-8 continuation bytes are 0b10xxxxxx.
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    let slice = buf.subarray(0, end).toString("utf8");
    const lastNl = slice.lastIndexOf("\n");
    if (lastNl > 0) slice = slice.slice(0, lastNl);
    return slice;
  }

  interface SpillConfig {
    spillThreshold: number;
    spillPreviewBytes: number;
    dedupByContentHash: boolean;
  }

  /**
   * For each oversized (resultText.length >= spillThreshold), non-protected tool call:
   *   - dedup hit (when enabled): registerDuplicate, no file written;
   *   - otherwise: write the full body to a sidecar file, set spill fields on the
   *     CapturedToolCall (resultText -> ""), and index it via addBatch.
   * Returns the set of toolCallIds that were handled (spilled or deduped) so the
   * caller drops them from the pending batch. Write-then-mutate: a write failure
   * leaves the tool call untouched (falls through to the normal flush pipeline).
   *
   * NOTE: protected-tool filtering happens BEFORE this is called (in turn_end),
   * so every toolCall reaching here is already eligible.
   */
  export async function spillOversizedBatch(args: {
    batch: CapturedBatch;
    indexer: ToolCallIndexer;
    config: SpillConfig;
    sessionDir: string;
    sessionId: string;
    appendEntry: (customType: string, data?: unknown) => void;
  }): Promise<Set<string>> {
    const { batch, indexer, config, sessionDir, sessionId, appendEntry } = args;
    const handled = new Set<string>();
    const toIndex: CapturedToolCall[] = [];

    for (const tc of batch.toolCalls) {
      if (tc.resultText.length < config.spillThreshold) continue;

      const hash = hashToolResult(tc.toolName, tc.resultText);

      if (config.dedupByContentHash) {
        const original = indexer.lookupByContent(tc.toolName, tc.resultText);
        if (original && original !== tc.toolCallId) {
          indexer.registerDuplicate(tc.toolCallId, original, appendEntry);
          handled.add(tc.toolCallId);
          continue;
        }
      }

      const path = blobPathFor(sessionDir, sessionId, tc.toolCallId);
      try {
        await mkdir(blobDirFor(sessionDir, sessionId), { recursive: true });
        await writeFile(path, tc.resultText, "utf-8");
      } catch {
        // Write failed: leave this tool call untouched for the normal pipeline.
        continue;
      }

      tc.spillBytes = Buffer.byteLength(tc.resultText, "utf8");
      tc.resultPreview = headPreview(tc.resultText, config.spillPreviewBytes);
      tc.spillPath = path;
      tc.contentHash = hash;
      tc.resultText = "";
      toIndex.push(tc);
      handled.add(tc.toolCallId);
    }

    if (toIndex.length > 0) {
      indexer.addBatch(
        { turnIndex: batch.turnIndex, timestamp: batch.timestamp, assistantText: "", toolCalls: toIndex },
        appendEntry,
      );
    }

    return handled;
  }
  ```

- [ ] **Step 4: Run, confirm pass**

  Run: `bun test src/spill.test.ts`
  Expected: PASS (all helper + orchestration cases).

- [ ] **Step 5: Typecheck + full suite**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts && bun test src/`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/spill.ts src/spill.test.ts
  git commit -m "spill: sidecar blob helpers + eager spillOversizedBatch orchestration"
  ```

---

## Wave 4 — Wiring

Depends on Wave 3 (Task 7 `spillOversizedBatch`), Wave 1 (Task 2 budget fns), Wave 2 (Task 3 config). Single task; owns `index.ts`.

### Task 8: Wire eager spill + budget-delta into `index.ts`

**TDD scenario:** Modifying integration glue — validated by the Wave 5 integration test + typecheck.

**Files:**
- Modify: `index.ts` (imports ~21/37; module state ~58-60 region; `session_start` ~628; `session_tree` ~657; `turn_end` ~667-731)

- [ ] **Step 1: Imports**

  Add to the budget import and a new spill import near the other `./src/*` imports:

  ```ts
  import { shouldBudgetFlush, shouldDeltaFlush, usageFraction } from "./src/budget.js";
  import { spillOversizedBatch } from "./src/spill.js";
  ```

- [ ] **Step 2: Module-level `previousFraction`**

  Near `let isFlushing = false;`:

  ```ts
  let previousFraction: number | null = null;
  ```

- [ ] **Step 3: Reset on `session_start` and `session_tree`**

  In both handlers, alongside `pendingBatches.length = 0;`:

  ```ts
  previousFraction = null;
  ```

- [ ] **Step 4: Eager spill in `turn_end` (after protected filter, before push)**

  In `turn_end`, after the existing `protectedToolSet` filter produces `capturedBatch` (the protected-filtered batch) and **before** `trimBatchToPendingRange`, run the spill on a protected-filtered batch. Concretely, replace the block that builds `batch` from `capturedBatch`:

  ```ts
  const protectedToolSet = new Set<string>(currentConfig.value.protectedTools);
  const filtered = {
    ...capturedBatch,
    toolCalls: capturedBatch.toolCalls.filter((tc) => !protectedToolSet.has(tc.toolName)),
  };

  // Eager spill: offload oversized single results before they ever reach a request.
  // addBatch inside makes them isSummarized; trimBatchToPendingRange then drops them
  // from the pending set automatically.
  try {
    await spillOversizedBatch({
      batch: filtered,
      indexer,
      config: {
        spillThreshold: currentConfig.value.spillThreshold,
        spillPreviewBytes: currentConfig.value.spillPreviewBytes,
        dedupByContentHash: currentConfig.value.dedupByContentHash,
      },
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      appendEntry: (type, data) => ctx.sessionManager.appendCustomEntry(type, data),
    });
  } catch {
    // Spill is best-effort; never block the turn. Oversized results fall through.
  }

  const batch = trimBatchToPendingRange(filtered);
  if (!batch) return;
  ```

  (Verify `getSessionDir`/`getSessionId` are on `ctx.sessionManager`: `session-manager.d.ts:189-191`, `ReadonlySessionManager` l.136.)

- [ ] **Step 5: Budget-delta trigger (OR with absolute)**

  Replace the existing budget-flush condition so either trigger fires, and update `previousFraction` after evaluating. Replace the `if (... shouldBudgetFlush(...)) { ... await flushPending(...) }` block with:

  ```ts
  const usage = ctx.getContextUsage?.();
  const budgetHit = shouldBudgetFlush(usage, currentConfig.value.autoBudgetThreshold);
  const deltaHit = shouldDeltaFlush(usage, previousFraction, currentConfig.value.budgetTurnDelta);
  // Update the baseline for next turn; leave it unchanged on a null-tokens turn
  // (e.g. right after compaction) so the next real reading compares to the last known.
  const f = usageFraction(usage);
  if (f != null) previousFraction = f;

  if (pendingBatches.length > 0 && !isFlushing && (budgetHit || deltaHit)) {
    safeNotify(
      ctx,
      `pruner: ${budgetHit ? "context budget reached" : "context jumped this turn"} — compacting ${n} pending turn${n === 1 ? "" : "s"}`,
      "info",
    );
    await flushPending(ctx, { delivery: "session" });
  }
  ```

  (`n` is the existing `pendingBatches.length` snapshot already computed above this block.)

- [ ] **Step 6: Typecheck + full suite**

  Run: `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts && bun test src/`
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add index.ts
  git commit -m "index: eager-spill oversized results + budget-delta flush trigger in turn_end"
  ```

---

## Wave 5 — Validation + docs

Depends on Wave 4. Parallel-safe: Tasks 9–10 own disjoint files (`src/oversized-spill.integration.test.ts` vs. `README.md` + `PRUNING.md`).

### Task 9: End-to-end integration test

**TDD scenario:** New integration test exercising spill → index → prune → recover → reconstruct.

**Files:**
- Create: `src/oversized-spill.integration.test.ts`

- [ ] **Step 1: Write the test**

  Drive the real pieces directly (no full extension boot): `spillOversizedBatch` → `pruneMessages` stub → `context_tree_query`-equivalent record read → reconstruct. Model it on `src/range-compression.integration.test.ts` for indexer/session-entry patterns.

  ```ts
  import { describe, it, expect } from "bun:test";
  import { mkdtemp, readFile, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { ToolCallIndexer } from "./indexer.js";
  import { spillOversizedBatch, blobPathFor } from "./spill.js";
  import { pruneMessages } from "./pruner.js";
  import type { CapturedBatch } from "./types.js";
  import { CUSTOM_TYPE_INDEX } from "./types.js";

  const cfg = { spillThreshold: 10, spillPreviewBytes: 16, dedupByContentHash: true };
  const batch = (tc: any): CapturedBatch => ({ turnIndex: 0, timestamp: 1, assistantText: "", toolCalls: [tc] });

  describe("oversized spill end-to-end", () => {
    it("spills, stubs in context, keeps full body on disk, survives reconstruct", async () => {
      const dir = await mkdtemp(join(tmpdir(), "spill-e2e-"));
      try {
        const indexer = new ToolCallIndexer();
        const entries: any[] = [];
        const appendEntry = (customType: string, data?: unknown) => { entries.push({ type: "custom", customType, data }); };

        const body = "BIG\n".repeat(1000);
        await spillOversizedBatch({
          batch: batch({ toolCallId: "tc1", toolName: "fetch", args: { url: "u" }, resultText: body, isError: false }),
          indexer, config: cfg, sessionDir: dir, sessionId: "sid", appendEntry,
        });

        // (a) full body on disk
        expect(await readFile(blobPathFor(dir, "sid", "tc1"), "utf-8")).toBe(body);

        // (b) persisted index entry has spillPath + preview, NOT the full body
        const idxEntry = entries.find((e) => e.customType === CUSTOM_TYPE_INDEX);
        const persisted = idxEntry.data.toolCalls[0];
        expect(persisted.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
        expect(persisted.resultText).toBe("");
        expect(persisted.resultPreview.length).toBeGreaterThan(0);
        expect(persisted.contentHash).toBeTruthy();

        // (c) pruneMessages emits the mechanical spill stub (no summary, no LLM)
        const msgs = [{ role: "toolResult", toolCallId: "tc1", toolName: "fetch", content: [{ type: "text", text: body }], isError: false, timestamp: 1 }];
        const { messages: out, pruned } = pruneMessages(msgs, indexer);
        expect(pruned).toBe(true);
        expect(out[0].content[0].text).toContain(blobPathFor(dir, "sid", "tc1"));
        expect(out[0].content[0].text).not.toContain("Summarized in pruner summary");

        // (d) reconstruct from the persisted entries: record still resolves, hash intact
        const indexer2 = new ToolCallIndexer();
        const fakeCtx = { sessionManager: { getBranch: () => entries } } as any;
        indexer2.reconstructFromSession(fakeCtx);
        const rec = indexer2.getRecord("tc1");
        expect(rec?.spillPath).toBe(blobPathFor(dir, "sid", "tc1"));
        expect(indexer2.lookupByContent("fetch", body)).toBe("tc1"); // persisted contentHash drives dedup
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  ```

- [ ] **Step 2: Run, confirm pass**

  Run: `bun test src/oversized-spill.integration.test.ts`
  Expected: PASS (a–d).

- [ ] **Step 3: Full suite + typecheck**

  Run: `bun test src/ && bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/oversized-spill.integration.test.ts
  git commit -m "test: oversized-spill end-to-end (spill, stub, disk body, reconstruct)"
  ```

### Task 10: Docs

**TDD scenario:** Docs — no tests.

**Files:**
- Modify: `README.md` (settings table + recovery note)
- Modify: `PRUNING.md` (eager-spill layer + budget-delta trigger)

- [ ] **Step 1: README — settings**

  Add `spillThreshold` (65536), `spillPreviewBytes` (2048), `budgetTurnDelta` (null) to the settings reference with one-line meanings, and a sentence on recovery: spilled outputs live next to the session file under `<sessionId>-blobs/`; the model reads the full body via the native `read` tool on the path in the stub, or `context_tree_query` by id.

- [ ] **Step 2: PRUNING — algorithm**

  Add a subsection documenting: (A) eager single-result spill at `turn_end` (threshold, sidecar location, synchronous index, mechanical stub, dedup precedence, write-then-mutate failure handling, no LLM); (B) budget-delta flush (`previousFraction`, ORed with absolute `autoBudgetThreshold`, null-token handling, post-restart gap). Note the `@mariozechner` → `@earendil-works` deprecation caveat is tracked separately (not here).

- [ ] **Step 3: Commit**

  ```bash
  git add README.md PRUNING.md
  git commit -m "docs: document eager spill + budget-delta flush"
  ```

---

## Self-review

- **Spec coverage:** A eager spill (Tasks 5,6,7,8) · hybrid storage / threshold (Tasks 1,3,7) · record + persisted contentHash (Tasks 1,4) · stub branching (Task 5) · recovery (Task 6) · failure handling / atomicity / collision (Task 7) · B budget-delta (Tasks 2,8) · config (Tasks 1,3) · testing (Tasks 2,5,7,9) · docs (Task 10). Cleanup-on-session-deletion and no-orphan-sweep are spec non-goals — no task, correct. Filename-collision "fall back to inline" from the spec is simplified in Task 7 to a write-failure fallthrough; documented in Notes (sanitize + unique ids make a true collision unreachable).
- **Placeholder scan:** none.
- **Type/API consistency:** `spillOversizedBatch` args, `ToolCallRecord`/`CapturedToolCall` fields, and `shouldDeltaFlush`/`usageFraction` signatures match across Tasks 1,2,5,7,8.
- **Wave disjointness:** W1 {types.ts} ∥ {budget.ts,budget.test.ts}; W2 {config.ts} ∥ {indexer.ts} ∥ {pruner.ts,pruner.test.ts} ∥ {query-tool.ts}; W3 single; W4 single; W5 {integration test} ∥ {README.md,PRUNING.md}. All disjoint.
