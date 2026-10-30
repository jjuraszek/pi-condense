import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface GitDiscovery {
  cwd?: string;
  git?: (args: string[]) => string;
}

function resolvedDestination(path: string): string {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  let destination = parse(absolute).root;
  for (const component of absolute.slice(destination.length).split(sep)) {
    if (!component || component === ".") continue;
    if (component === "..") {
      destination = dirname(destination);
      continue;
    }
    const candidate = join(destination, component);
    try {
      destination = realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink cannot be treated as a nonexistent directory.
      if (lstatSync(candidate, { throwIfNoEntry: false })) throw error;
      destination = candidate;
    }
  }
  return destination;
}

export function assertOutsideRepo(dir: string, discovery: GitDiscovery = {}): string {
  const refusal = "Replay destination must be outside all checkouts";
  try {
    const cwd = discovery.cwd ?? process.cwd();
    const git = discovery.git ?? ((args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    const common = git(["rev-parse", "--git-common-dir"]).trim();
    const trees = git(["worktree", "list", "--porcelain", "-z"]).split("\0").flatMap(part => part.split("\n")).filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
    if (!top || !common || trees.length === 0) throw Error(refusal);
    const roots = [resolve(cwd, top), dirname(resolve(cwd, common)), ...trees.map(tree => resolve(cwd, tree))].map(root => realpathSync(root));
    const destination = resolvedDestination(dir);
    let ancestor = destination;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    let enclosingTop = "";
    try {
      enclosingTop = execFileSync("git", ["-C", ancestor, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      // An existing directory outside a checkout has no git toplevel.
    }
    if (enclosingTop) throw Error(`${refusal}: ${enclosingTop}`);
    if (roots.some(root => {
      const child = relative(root, destination);
      return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    })) throw Error(refusal);
    return destination;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(refusal)) throw error;
    throw new Error(refusal);
  }
}
