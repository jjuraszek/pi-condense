import type { CapturedBatch } from "./types.js";

export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
}

export interface SummaryMessageDetailsLike {
  toolCallRefs?: SummaryToolCallRef[];
  toolCallIds?: string[];
}

const SHORT_ID_PREFIX = "t";

export function buildShortToolCallRefs(
  toolCallIds: string[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = toolCallIds.map((toolCallId, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId,
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!details || typeof details !== "object") return [];

  const raw = details as SummaryMessageDetailsLike;
  if (Array.isArray(raw.toolCallRefs)) {
    return raw.toolCallRefs
      .filter(
        (ref): ref is SummaryToolCallRef =>
          !!ref && typeof ref.shortId === "string" && typeof ref.toolCallId === "string",
      )
      .map((ref) => ({ shortId: ref.shortId, toolCallId: ref.toolCallId }));
  }

  if (Array.isArray(raw.toolCallIds)) {
    return raw.toolCallIds.filter((id): id is string => typeof id === "string").map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized tool refs**: ${refList}\n` +
    `Use \`context_tree_query\` with these refs to retrieve the original full outputs.`
  );
}

export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]) {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}

/**
 * Rewrites line-leading `[[N:name]]` labels emitted by the summarizer into
 * inline `` `tN` `` refs. `refs` and `toolNames` are positionally aligned to
 * the batch's tool-call order. The echoed name is validated against the tool
 * at position N; a mismatch or out-of-range N strips the label (footer-only).
 * A catch-all strip pass on non-fenced lines removes any surviving well-formed
 * label token (wrapped, numbered, or blockquoted) so no raw `[[N:name]]` token
 * ever leaks into context; fenced code blocks remain exempt.
 */
export function substituteInlineRefs(
  text: string,
  refs: SummaryToolCallRef[],
  toolNames: string[],
): string {
  const LABEL = /^(\s*(?:[-*]\s+)?)\[\[(\d+):([^\]\n]+)\]\]\s*/;
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = lines[i].replace(LABEL, (_m, prefix: string, numStr: string, name: string) => {
      const n = Number(numStr);
      const ref = refs[n - 1];
      const expected = toolNames[n - 1];
      if (!ref || expected === undefined) return prefix;
      if (name.trim().toLowerCase() !== expected.trim().toLowerCase()) return prefix;
      return `${prefix}\`${ref.shortId}\` `;
    });
    lines[i] = lines[i].replace(/\[\[\d+:[^\]\n]+\]\]\s*/g, "");
  }
  return lines.join("\n");
}
