// One-level substitution only: the replaced text is not re-scanned.
// This is intentional — if summary B contains "{b1}", that placeholder
// was already resolved (or left literal) when B was originally generated.
// Re-scanning would require cycle detection across an arbitrary graph and
// could silently expand stale content if the session is replayed later.
const BLOCK_REF_RE = /\{b(\d+)\}/g;

export function substituteBlockRefs(
  text: string,
  blockSummaryLookup: (blockId: string) => string | undefined,
  options?: { selfBlockId?: string },
): string {
  const selfBlockId = options?.selfBlockId;
  return text.replace(BLOCK_REF_RE, (match, digits) => {
    const blockId = `b${digits}`;
    if (blockId === selfBlockId) return match;
    const resolved = blockSummaryLookup(blockId);
    return resolved ?? match;
  });
}
