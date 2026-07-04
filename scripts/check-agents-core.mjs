#!/usr/bin/env node
// Enforces that the shared-core region in AGENTS.md is byte-identical to
// AGENTS.core.md. Zero deps - runs under node or bun. `--fix` rewrites the
// region from AGENTS.core.md.
//
// Cross-repo: AGENTS.core.md and this script are copied verbatim into
// pi-quiver / pi-cohort / pi-gauntlet / pi-condense. To change the shared core,
// edit AGENTS.core.md, run `--fix` here, then copy both files to the siblings
// and re-run `--fix` in each. The `v<N>` marker stamp makes drift greppable.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = join(root, "AGENTS.core.md");
const agentsPath = join(root, "AGENTS.md");
const BEGIN = "<!-- agents-core:begin";
const END = "<!-- agents-core:end";
const fix = process.argv.includes("--fix");

const norm = (s) => s.replace(/\r\n/g, "\n").trim();
const core = norm(readFileSync(corePath, "utf8"));
const agents = readFileSync(agentsPath, "utf8");

const beginIdx = agents.indexOf(BEGIN);
const endIdx = agents.indexOf(END);
if (beginIdx === -1 || endIdx === -1) {
  console.error(`check-agents-core: missing "${BEGIN} ..." / "${END} ..." markers in AGENTS.md`);
  process.exit(1);
}
const beginLineEnd = agents.indexOf("\n", beginIdx);
const region = norm(agents.slice(beginLineEnd + 1, endIdx));

if (region === core) {
  console.log("check-agents-core: AGENTS.md shared core matches AGENTS.core.md");
  process.exit(0);
}

if (fix) {
  const head = agents.slice(0, beginLineEnd + 1);
  const tail = agents.slice(endIdx);
  writeFileSync(agentsPath, `${head}${core}\n\n${tail}`);
  console.log("check-agents-core: rewrote AGENTS.md shared core from AGENTS.core.md");
  process.exit(0);
}

console.error("check-agents-core: DRIFT between AGENTS.md shared core and AGENTS.core.md");
console.error("  run: node scripts/check-agents-core.mjs --fix");
process.exit(1);
