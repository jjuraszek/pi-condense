import { describe, expect, test } from "bun:test";
import { substituteBlockRefs } from "./nested-placeholders.js";

const lookup = (id: string): string | undefined => {
  const map: Record<string, string> = {
    b1: "summary of chain one",
    b2: "summary of chain two",
    b3: "chain three with {b2} inside",
  };
  return map[id];
};

describe("substituteBlockRefs", () => {
  test("empty text returns empty string", () => {
    expect(substituteBlockRefs("", lookup)).toBe("");
  });

  test("text with no placeholders is unchanged", () => {
    const text = "no placeholders here, just prose";
    expect(substituteBlockRefs(text, lookup)).toBe(text);
  });

  test("single {b1} is substituted", () => {
    expect(substituteBlockRefs("{b1}", lookup)).toBe("summary of chain one");
  });

  test("multiple references in one text are all resolved", () => {
    expect(substituteBlockRefs("{b1} and {b2}", lookup)).toBe(
      "summary of chain one and summary of chain two",
    );
  });

  test("missing blockId leaves the literal {bN} in place", () => {
    expect(substituteBlockRefs("{b99}", lookup)).toBe("{b99}");
  });

  test("missing blockId among valid ones leaves only the unknown one", () => {
    expect(substituteBlockRefs("{b1} and {b99}", lookup)).toBe("summary of chain one and {b99}");
  });

  test("self-reference is refused even when lookup has a value", () => {
    // b3 is in the lookup, but selfBlockId=b3 means it must stay literal
    expect(substituteBlockRefs("{b3} foo", lookup, { selfBlockId: "b3" })).toBe("{b3} foo");
  });

  test("self-reference refused, other refs still substituted", () => {
    expect(substituteBlockRefs("{b3} and {b1}", lookup, { selfBlockId: "b3" })).toBe(
      "{b3} and summary of chain one",
    );
  });

  test("one-level only: substituted text containing {b2} is NOT re-expanded", () => {
    // b3 → "chain three with {b2} inside"
    // The {b2} inside that expansion must survive as a literal in the output.
    const result = substituteBlockRefs("{b3}", lookup);
    expect(result).toBe("chain three with {b2} inside");
    // Explicitly: {b2} in the output is the literal string, not "summary of chain two"
    expect(result).not.toContain("summary of chain two");
  });

  test("adjacent placeholders handled cleanly", () => {
    expect(substituteBlockRefs("{b1}{b2}", lookup)).toBe(
      "summary of chain onesummary of chain two",
    );
  });

  test("placeholders embedded in surrounding prose", () => {
    expect(substituteBlockRefs("Before {b1} middle {b2} after", lookup)).toBe(
      "Before summary of chain one middle summary of chain two after",
    );
  });

  test("lookup returning undefined leaves placeholder literal (null-safe contract)", () => {
    // `resolved ?? match` only falls through to the literal when lookup returns undefined.
    // pruner.ts collapses empty-string summary bodies to undefined before calling here
    // (`|| undefined`), so this test pins the undefined-→-literal path that the
    // pruner relies on to avoid silently erasing placeholders when summary bodies are missing.
    const missingLookup = (_: string): string | undefined => undefined;
    expect(substituteBlockRefs("{b1}", missingLookup)).toBe("{b1}");
    expect(substituteBlockRefs("{b1} text", missingLookup)).toBe("{b1} text");
  });
});
