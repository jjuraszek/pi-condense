import { describe, expect, test } from "bun:test";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { globToRegExp, isProtected, normalizePath } from "./protected.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("globToRegExp", () => {
  test("** crosses path segments", () => {
    expect(globToRegExp("**/skills/**/*.md").test("/Users/x/.agents/skills/release/SKILL.md")).toBe(true);
    expect(globToRegExp("**/skills/**/*.md").test("a/skills/b/c/notes.md")).toBe(true);
  });

  test("**/ matches zero directories", () => {
    expect(globToRegExp("**/SKILL.md").test("SKILL.md")).toBe(true);
    expect(globToRegExp("**/skills/**/*.md").test("skills/foo.md")).toBe(true);
  });

  test("* and ? are segment-local", () => {
    expect(globToRegExp("skills/*.md").test("skills/a/b.md")).toBe(false);
    expect(globToRegExp("skills/?.md").test("skills/a.md")).toBe(true);
    expect(globToRegExp("skills/?.md").test("skills//x.md")).toBe(false);
  });

  test("regex metacharacters in pattern are literals", () => {
    expect(globToRegExp("a+b/(c).md").test("a+b/(c).md")).toBe(true);
    expect(globToRegExp("a.md").test("aXmd")).toBe(false);
  });

  test("full-path anchored match", () => {
    expect(globToRegExp("skills/a.md").test("xskills/a.md")).toBe(false);
    expect(globToRegExp("skills/a.md").test("skills/a.md.bak")).toBe(false);
  });

  test("case-sensitive", () => {
    expect(globToRegExp("**/SKILL.md").test("a/skill.md")).toBe(false);
  });
});

describe("isProtected defaults", () => {
  test.each([".pi/gauntlet-overrides.md", "doc/gauntlet-overrides.md"])(
    "protects reads of %s",
    (path) => {
      expect(isProtected("read", { path }, DEFAULT_CONFIG)).toBe(true);
    },
  );

  test("protects skill reads", () => {
    expect(isProtected("read", { path: "/h/skills/x/SKILL.md" }, DEFAULT_CONFIG)).toBe(true);
  });

  test("does not protect sibling settings reads", () => {
    expect(isProtected("read", { path: ".pi/settings.json" }, DEFAULT_CONFIG)).toBe(false);
  });

  test("does not infer paths from bash commands", () => {
    expect(isProtected("bash", { command: "cat .pi/gauntlet-overrides.md" }, DEFAULT_CONFIG)).toBe(false);
  });
});

describe("isProtected", () => {
  const cfg = { protectedTools: ["todowrite"], protectedPaths: ["**/skills/**/*.md"] };

  test("matches by tool name regardless of args", () => {
    expect(isProtected("todowrite", undefined, cfg)).toBe(true);
  });

  test("matches by path glob", () => {
    expect(isProtected("read", { path: "/h/skills/x/SKILL.md" }, cfg)).toBe(true);
    expect(isProtected("read", { path: "/h/src/app.ts" }, cfg)).toBe(false);
  });

  test.each(["ok", "error"] as const)("protects nested skill reads with status %s", (status) => {
    expect(isProtected("codemode", { code: "console.log(await tools.read({ path: 'skills/x/SKILL.md' }))" }, cfg, {
      complete: true,
      calls: [{ id: "nested-read", name: "read", arguments: { path: "skills/x/SKILL.md" }, status }],
    })).toBe(true);
  });

  test.each([undefined, {}, { path: "source.ts" }])("protects nested tool names with arguments %j and path matching disabled", (args) => {
    for (const outerName of ["codemode", "another-script-tool"]) {
      expect(isProtected(outerName, {}, { protectedTools: ["todowrite"], protectedPaths: [] }, {
        complete: true, calls: [{ id: "nested", name: "todowrite", arguments: args, status: "ok" }],
      })).toBe(true);
    }
  });

  test.each([
    { complete: false, calls: [] },
    { complete: false, calls: [{ id: "write", name: "write", arguments: { path: "source.ts" }, status: "ok" }] },
    { complete: false, calls: [{ id: "read", name: "read", argumentsBytes: 8193, status: "ok" }] },
    { complete: false, calls: [{ id: "read", name: "read", arguments: { path: "source.ts" }, status: "unfinished" }] },
  ] satisfies NestedToolCalls[])("protects incomplete records %j even with empty configuration", (nested) => {
    for (const config of [cfg, { protectedTools: [], protectedPaths: [] }]) {
      expect(isProtected("codemode", {}, config, nested)).toBe(true);
    }
  });

  test.each([
    undefined,
    { complete: true, calls: [] },
    { complete: true, calls: [{ id: "read", name: "read", arguments: { path: "source.ts" }, status: "ok" }] },
    { complete: true, calls: [{ id: "read", name: "read", arguments: { path: 42 }, status: "ok" }] },
    "malformed",
    { complete: false, calls: {} },
  ])("keeps unmatched or malformed nested records %j prunable without changing direct protection", (nested) => {
    const record = nested as NestedToolCalls | undefined;
    expect(isProtected("codemode", { code: "tools.read({path: 'skills/x/SKILL.md'})" }, cfg, record)).toBe(false);
    expect(isProtected("todowrite", {}, cfg, record)).toBe(true);
    expect(isProtected("read", { path: "skills/x/SKILL.md" }, cfg, record)).toBe(true);
  });

  test("backslashes normalized to forward slashes", () => {
    expect(isProtected("read", { path: "h\\skills\\x\\SKILL.md" }, cfg)).toBe(true);
  });

  test("non-string / missing path is not protected", () => {
    expect(isProtected("read", { path: 42 }, cfg)).toBe(false);
    expect(isProtected("read", {}, cfg)).toBe(false);
    expect(isProtected("read", undefined, cfg)).toBe(false);
    expect(isProtected("read", null, cfg)).toBe(false);
  });

  test("empty config protects nothing", () => {
    expect(isProtected("read", { path: "skills/a/SKILL.md" }, { protectedTools: [], protectedPaths: [] })).toBe(false);
  });
});

describe("normalizePath", () => {
  test("normalizePath turns backslashes into forward slashes and nothing else", () => {
    expect(normalizePath("h\\skills\\x\\SKILL.md")).toBe("h/skills/x/SKILL.md");
    expect(normalizePath("./a/../b.md")).toBe("./a/../b.md");
  });
});
