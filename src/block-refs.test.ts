import { describe, expect, test } from "bun:test";
import { BlockRefIssuer } from "./block-refs.js";

describe("BlockRefIssuer", () => {
  test("first issue() returns b1", () => {
    const issuer = new BlockRefIssuer();
    expect(issuer.issue()).toBe("b1");
  });

  test("subsequent calls are monotonic", () => {
    const issuer = new BlockRefIssuer();
    expect(issuer.issue()).toBe("b1");
    expect(issuer.issue()).toBe("b2");
    expect(issuer.issue()).toBe("b3");
  });

  test("rebuildFrom([]) → next is b1", () => {
    const issuer = new BlockRefIssuer();
    issuer.rebuildFrom([]);
    expect(issuer.issue()).toBe("b1");
  });

  test("rebuildFrom([b1, b2]) → next is b3", () => {
    const issuer = new BlockRefIssuer();
    issuer.rebuildFrom(["b1", "b2"]);
    expect(issuer.issue()).toBe("b3");
  });

  test("rebuildFrom gapped sequence → max+1, not gap-fill", () => {
    const issuer = new BlockRefIssuer();
    issuer.rebuildFrom(["b1", "b3"]);
    expect(issuer.issue()).toBe("b4");
  });

  test("rebuildFrom resets counter even after prior issues", () => {
    const issuer = new BlockRefIssuer();
    issuer.issue(); // b1
    issuer.issue(); // b2
    issuer.rebuildFrom(["b5"]);
    expect(issuer.issue()).toBe("b6");
  });
});
