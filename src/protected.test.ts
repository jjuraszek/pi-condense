import { describe, expect, test } from "bun:test";
import { globToRegExp, isProtected } from "./protected.js";

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

describe("isProtected", () => {
  const cfg = { protectedTools: ["todowrite"], protectedPaths: ["**/skills/**/*.md"] };

  test("matches by tool name regardless of args", () => {
    expect(isProtected("todowrite", undefined, cfg)).toBe(true);
  });

  test("matches by path glob", () => {
    expect(isProtected("read", { path: "/h/skills/x/SKILL.md" }, cfg)).toBe(true);
    expect(isProtected("read", { path: "/h/src/app.ts" }, cfg)).toBe(false);
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
