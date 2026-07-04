import { describe, expect, test } from "bun:test";
import { substituteInlineRefs, formatSummaryToolCallRefs, type SummaryToolCallRef } from "./summary-refs.js";

describe("substituteInlineRefs", () => {
  const refs: SummaryToolCallRef[] = [
    { shortId: "t1", toolCallId: "a" },
    { shortId: "t2", toolCallId: "b" },
  ];
  const names = ["read", "bash"];

  test("in-range and matching name rewrites to inline ref", () => {
    expect(substituteInlineRefs("- [[1:read]] Read a.ts", refs, names)).toBe("- `t1` Read a.ts");
    expect(substituteInlineRefs("- [[2:bash]] ran ls", refs, names)).toBe("- `t2` ran ls");
  });

  test("does not add extra t prefix", () => {
    const out = substituteInlineRefs("[[1:read]] x", refs, names);
    expect(out).toBe("`t1` x");
    expect(out).not.toContain("tt1");
  });

  test("name match is trimmed and case-insensitive", () => {
    expect(substituteInlineRefs("- [[1:Read]] x", refs, names)).toBe("- `t1` x");
  });

  test("name mismatch strips label", () => {
    expect(substituteInlineRefs("- [[2:read]] x", refs, names)).toBe("- x");
  });

  test("out of range strips label", () => {
    expect(substituteInlineRefs("- [[9:read]] x", refs, names)).toBe("- x");
  });

  test("absent label leaves line unchanged", () => {
    expect(substituteInlineRefs("- plain bullet", refs, names)).toBe("- plain bullet");
  });

  test("duplicate labels on separate lines both substituted", () => {
    expect(substituteInlineRefs("- [[2:bash]] first\n- [[2:bash]] second", refs, names)).toBe(
      "- `t2` first\n- `t2` second",
    );
  });

  test("single-bracket lookalikes are untouched", () => {
    const input = "used argv[1] and items[0] here";
    expect(substituteInlineRefs(input, refs, names)).toBe(input);
  });

  test("mid-line well-formed label token is stripped (leak guard)", () => {
    expect(substituteInlineRefs("used argv[1] and [[1:read]] mid", refs, names)).toBe(
      "used argv[1] and mid",
    );
  });

  test("label inside fenced code block is untouched", () => {
    const input = "```\n[[1:read]] literal\n```";
    expect(substituteInlineRefs(input, refs, names)).toBe(input);
  });

  test("wrapped label ([[1:read]] in **bold**) is stripped, no raw token leaked", () => {
    const input = "- **[[1:read]]** x";
    expect(substituteInlineRefs(input, refs, names)).toBe("- **** x");
  });

  test("numbered-list label leak guard: token stripped, no anchored match", () => {
    expect(substituteInlineRefs("1. [[1:read]] did x", refs, names)).toBe("1. did x");
  });

  test("blockquote label leak guard: token stripped, no anchored match", () => {
    expect(substituteInlineRefs("> [[1:read]] did x", refs, names)).toBe("> did x");
  });

  test("fenced non-first-line label is still exempt from catch-all strip", () => {
    const input = "```\nfoo [[1:read]] bar\n```";
    expect(substituteInlineRefs(input, refs, names)).toBe(input);
  });

  test("range-fusion: inline ref survives fusion-input concatenation across batches", () => {
    const body = substituteInlineRefs("- [[1:read]] did a thing", refs, names);
    expect(body).toBe("- `t1` did a thing");
    expect(body).toContain("`t1`");
    const fusionInput = [body, body].join("\n---\n");
    expect(fusionInput).toContain("`t1`");
  });

  test("N=0 is out of range and strips label", () => {
    expect(substituteInlineRefs("- [[0:read]] x", refs, names)).toBe("- x");
  });

  test("empty input returns empty string", () => {
    expect(substituteInlineRefs("", refs, names)).toBe("");
  });

  test("collapses multiple trailing spaces to one", () => {
    expect(substituteInlineRefs("- [[1:read]]    x", refs, names)).toBe("- `t1` x");
  });

  test("label at end of line has single trailing space, no phantom double", () => {
    expect(substituteInlineRefs("- [[1:read]]", refs, names)).toBe("- `t1` ");
  });

  test("dotted/namespaced tool name matches and validates", () => {
    const nsRefs: SummaryToolCallRef[] = [{ shortId: "t1", toolCallId: "a" }];
    const nsNames = ["server.tool"];
    expect(substituteInlineRefs("- [[1:server.tool]] did x", nsRefs, nsNames)).toBe("- `t1` did x");
  });

  test("dotted/namespaced tool name mismatch strips label, does not leak", () => {
    const nsRefs: SummaryToolCallRef[] = [{ shortId: "t1", toolCallId: "a" }];
    const nsNames = ["server.tool"];
    expect(substituteInlineRefs("- [[1:other.tool]] x", nsRefs, nsNames)).toBe("- x");
  });

  test("composition with formatSummaryToolCallRefs footer", () => {
    const body = substituteInlineRefs("- [[1:read]] a\n- [[2:bash]] b", refs, names);
    const footer = formatSummaryToolCallRefs(refs);
    for (const ref of refs) {
      expect(body).toContain(`\`${ref.shortId}\``);
      expect(footer).toContain(`\`${ref.shortId}\``);
    }
  });
});
