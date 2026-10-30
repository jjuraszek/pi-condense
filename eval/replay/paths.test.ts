import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOutsideRepo } from "./paths";

test("rejects an unrelated git checkout and accepts a plain temporary directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-paths-"));
  const aliases = mkdtempSync(join(tmpdir(), "replay-paths-aliases-"));
  try {
    expect(assertOutsideRepo(join(dir, "corpus"))).toBe(join(realpathSync(dir), "corpus"));
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    expect(() => assertOutsideRepo(join(dir, "corpus"))).toThrow("Replay destination must be outside all checkouts");
    const file = join(dir, "jobs.json");
    writeFileSync(file, "{}");
    const alias = join(aliases, "jobs.json");
    symlinkSync(file, alias);
    for (const path of [file, alias]) {
      expect(() => assertOutsideRepo(path)).toThrow("Replay destination must be outside all checkouts");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(aliases, { recursive: true, force: true });
  }
});

test("guards every discovered checkout and symlink children with component boundaries", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "replay-paths-")));
  const roots = ["current", "primary", "registered"].map(name => join(dir, name));
  roots.forEach(root => mkdirSync(root));
  mkdirSync(join(roots[1], ".git"));
  const git = (args: string[]) => args.includes("--show-toplevel") ? roots[0] : args.includes("--git-common-dir") ? join(roots[1], ".git") : roots.map(root => `worktree ${root}\nHEAD abc\nbranch refs/heads/test\n`).join("\n");
  for (const [i, root] of roots.entries()) {
    const alias = join(dir, `alias-${i}`);
    symlinkSync(root, alias);
    for (const path of [root, join(root, "new", "child"), alias, join(alias, "new", "child")]) {
      expect(() => assertOutsideRepo(path, { cwd: dir, git })).toThrow("Replay destination must be outside all checkouts");
    }
    const child = join(root, "child");
    mkdirSync(child);
    const childAlias = join(dir, `child-alias-${i}`);
    symlinkSync(child, childAlias);
    expect(() => assertOutsideRepo(`${childAlias}/../corpus`, { cwd: dir, git })).toThrow("Replay destination must be outside all checkouts");
    expect(assertOutsideRepo(`${root}-sibling`, { cwd: dir, git })).toBe(`${root}-sibling`);
  }
  expect(assertOutsideRepo(join(dir, "safe"), { cwd: dir, git })).toBe(join(dir, "safe"));
  expect(() => assertOutsideRepo(dir, { cwd: dir, git: () => { throw Error("git unavailable"); } })).toThrow("Replay destination");
});
