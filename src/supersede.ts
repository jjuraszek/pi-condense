import { normalizePath } from "./protected.js";
import { occKey, resultTimestampOf } from "./occurrence-key.js";

/**
 * Protected reads are never indexed, so nothing else in the pipeline ever
 * collapses a re-read of the same skill file. This module keeps only the
 * newest protected read per `args.path` verbatim (spec 2026-09-07).
 */
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

export function findSuperseded(messages: any[], isProtected: IsProtectedFn): SupersededCandidate[] {
  // Provider ids repeat across turns and an aborted call has no result, so pairing
  // uses the same per-turn open-set model as orphan-sweep, not a global per-id cursor.
  let open = new Map<string, any>();
  const byPath = new Map<string, SupersededCandidate[]>();

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
      const list = byPath.get(path);
      if (list) list.push(cand);
      else byPath.set(path, [cand]);
      continue;
    }
    open = new Map();
  }

  const out: SupersededCandidate[] = [];
  for (const list of byPath.values()) for (let i = 0; i < list.length - 1; i++) out.push(list[i]);
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
