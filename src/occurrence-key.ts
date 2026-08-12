/**
 * Provider tool-call ids are unique only within one response (see
 * doc/specs/2026-08-12-toolcall-id-collisions.md), so bare ids cannot key
 * session-durable records. The ToolResultMessage timestamp is the one
 * discriminant readable identically at capture time and at render time.
 *
 * A key with no parsable numeric suffix IS a bare id - that is the legacy
 * shape for records persisted before this field existed.
 */
const SEP = "@";

export function occKey(toolCallId: string, resultTimestamp?: number): string {
  return resultTimestamp === undefined ? toolCallId : `${toolCallId}${SEP}${resultTimestamp}`;
}

/**
 * Narrows an untrusted value to the numeric timestamp discriminant, or
 * `undefined` if it isn't a number. Shared by every ingress point that reads
 * a ToolResultMessage-shaped `.timestamp` off data of uncertain provenance
 * (live turn events, session JSON, summary details JSON).
 */
export function resultTimestampOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function parseOccKey(key: string): { toolCallId: string; resultTimestamp?: number } {
  const i = key.lastIndexOf(SEP);
  if (i <= 0) return { toolCallId: key };
  const suffix = key.slice(i + 1);
  if (!/^\d+$/.test(suffix)) return { toolCallId: key };
  return { toolCallId: key.slice(0, i), resultTimestamp: Number(suffix) };
}

export function bareToolCallId(key: string): string {
  return parseOccKey(key).toolCallId;
}
