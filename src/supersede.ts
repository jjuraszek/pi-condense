import { normalizePath } from "./protected.js";
import { occKey, resultTimestampOf } from "./occurrence-key.js";

/** Protected reads stay verbatim until a later same-path read covers their delivered lines. */
export interface SupersededCandidate {
  toolCallId: string;
  path: string;
  timestamp: number | undefined;
  resultIndex: number;
}

export interface SupersedeState {
  /** Earliest result timestamp the next render will rewrite anyway; 0 = cold cache, activate everything. */
  floor: number | undefined;
  /** occKey(toolCallId, resultTimestamp) of candidates whose stub has taken effect (session-sticky). */
  activated: Set<string>;
}

export function createSupersedeState(): SupersedeState {
  return { floor: undefined, activated: new Set() };
}

export function lowerFloor(state: SupersedeState, t: number | undefined): void {
  if (t === undefined) return;
  state.floor = state.floor === undefined ? t : Math.min(state.floor, t);
}

export function earliestResultTimestamp(toolCalls: readonly { resultTimestamp?: number }[]): number | undefined {
  let min: number | undefined;
  for (const tc of toolCalls) {
    if (tc.resultTimestamp !== undefined && (min === undefined || tc.resultTimestamp < min)) min = tc.resultTimestamp;
  }
  return min;
}

export function earliestChainStart(entries: readonly { startUserTimestamp: number }[]): number | undefined {
  let min: number | undefined;
  for (const e of entries) if (min === undefined || e.startUserTimestamp < min) min = e.startUserTimestamp;
  return min;
}

export function supersededStub(path: string): string {
  return `[Superseded: ${path} was read again later in this conversation - see the newer read. Re-read the file if this earlier content is needed.]`;
}

export type IsProtectedFn = (toolName: string, args: unknown) => boolean;

interface DeliveredRange {
  start: number;
  end: number;
}

function deliveredRange(args: Record<string, unknown>, result: any): DeliveredRange {
  const start = typeof args.offset === "number" ? Math.max(1, args.offset) : 1;
  const limit = args.limit;
  let end = typeof limit === "number" ? (limit <= 0 ? start - 1 : start + limit - 1) : Infinity;
  for (const block of result.content ?? []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (/^\[Line \d+ is [^,]+, exceeds [^ ]+ limit\. Use bash: .*\]$/.test(block.text)) return { start, end: start - 1 };
    const cap = block.text.match(/(?:^|\n)\[Showing lines \d+-(\d+) of \d+(?: \([^)]*limit\))?\. Use offset=\d+ to continue\.\]$/);
    if (cap) end = Math.min(end, Number(cap[1]));
  }
  return { start, end };
}

function covers(later: DeliveredRange, earlier: DeliveredRange): boolean {
  if (later.end < later.start) return false;
  return earlier.end < earlier.start || (later.start <= earlier.start && later.end >= earlier.end);
}

export function findSuperseded(messages: any[], isProtected: IsProtectedFn): SupersededCandidate[] {
  // Provider ids repeat across turns and an aborted call has no result, so pairing
  // uses the same per-turn open-set model as orphan-sweep, not a global per-id cursor.
  let open = new Map<string, any>();
  const byPath = new Map<string, { candidate: SupersededCandidate; range: DeliveredRange }[]>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      open = new Map();
      for (const block of m.content) if (block?.type === "toolCall") open.set(block.id, block);
      continue;
    }
    if (m?.role === "toolResult") {
      const block = open.get(m.toolCallId);
      if (!block) continue;
      open.delete(m.toolCallId);
      const args = block.input ?? block.args ?? block.arguments ?? {};
      if (!isProtected(block.name, args)) continue;
      const rawPath = (args as Record<string, unknown>)?.path;
      if (typeof rawPath !== "string") continue;
      const path = normalizePath(rawPath);
      const cand: SupersededCandidate = {
        toolCallId: block.id,
        path,
        timestamp: resultTimestampOf(m.timestamp),
        resultIndex: i,
      };
      const occurrence = { candidate: cand, range: deliveredRange(args, m) };
      const list = byPath.get(path);
      if (list) list.push(occurrence);
      else byPath.set(path, [occurrence]);
      continue;
    }
    open = new Map();
  }

  const out: SupersededCandidate[] = [];
  for (const list of byPath.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!covers(list[j].range, list[i].range)) continue;
        out.push(list[i].candidate);
        break;
      }
    }
  }
  out.sort((a, b) => a.resultIndex - b.resultIndex);
  return out;
}

const keyOf = (c: SupersededCandidate) => occKey(c.toolCallId, c.timestamp);

/**
 * Phase 1b of pruneMessages. Reference-preserving when nothing is stubbed.
 * Consumes `state.floor` exactly once per call.
 */
export function applySupersede(messages: any[], state: SupersedeState, isProtected: IsProtectedFn): any[] {
  const candidates = findSuperseded(messages, isProtected);
  if (state.floor !== undefined) {
    const floor = state.floor;
    for (const c of candidates) {
      if (floor === 0 || (c.timestamp !== undefined && c.timestamp >= floor)) state.activated.add(keyOf(c));
    }
    state.floor = undefined;
  }
  let out = messages;
  for (const c of candidates) {
    if (!state.activated.has(keyOf(c))) continue;
    if (out === messages) out = messages.slice();
    const orig = messages[c.resultIndex];
    out[c.resultIndex] = { ...orig, content: [{ type: "text", text: supersededStub(c.path) }], isError: false };
  }
  return out;
}
