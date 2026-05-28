/**
 * Content-hash helper for the dedup pre-flush pass.
 *
 * Hashes (toolName, normalize(resultText)) via SHA-1 into a hex digest.
 * Normalization is intentionally conservative: line-ending normalization
 * (`\r\n` → `\n`), per-line trailing whitespace stripping, and a final
 * whole-string trim. Internal whitespace, tabs, and capitalization are
 * preserved so two genuinely different outputs do NOT collide.
 *
 * SHA-1 is overkill at this scale (~10⁵ records per long session at most)
 * but is fast, built into Node's `crypto` module, and trivially readable.
 *
 * The `\0` separator between toolName and resultText prevents pathological
 * collisions where two `(name, payload)` pairs concatenate to the same
 * string (e.g. `("ab", "c")` vs `("a", "bc")`).
 */

import { createHash } from "node:crypto";

function normalize(resultText: string): string {
  const lf = resultText.replace(/\r\n/g, "\n");
  return lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function hashToolResult(toolName: string, resultText: string): string {
  return createHash("sha1")
    .update(toolName)
    .update("\0")
    .update(normalize(resultText))
    .digest("hex");
}
