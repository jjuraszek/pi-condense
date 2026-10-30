import { TOKEN_CLASS, isIdentifierShaped, selectMiddleLines } from "../../src/batch-capture.js";
import type { CapturedBatch } from "../../src/types.js";
import type { ReplaySession } from "./extract.js";

export interface OracleCandidate {
  text: string;
  resultIndex: number;
  resultLength: number;
  offset: number;
  inMiddle: boolean;
}
export interface SelectionStat { resultIndex: number; k: number; budgetExhausted: boolean }

export function selectionStats(batch: CapturedBatch): SelectionStat[] {
  const anchors = new Set<string>();
  for (const text of [batch.assistantText, ...batch.toolCalls.map(c => JSON.stringify(c.args, null, 2))]) {
    for (const token of text.matchAll(TOKEN_CLASS)) if (isIdentifierShaped(token[0])) anchors.add(token[0]);
  }
  return batch.toolCalls.flatMap((call, resultIndex) => {
    if (call.spillPath || call.resultText.length <= 8000) return [];
    const middle = call.resultText.slice(4000, -4000);
    const k = selectMiddleLines(middle, anchors, 2000).length;
    return k > 0 ? [{ resultIndex, k, budgetExhausted: selectMiddleLines(middle, anchors, Number.MAX_SAFE_INTEGER).length > k }] : [];
  });
}

// Keep provenance per result; the public oracle Set deduplicates batch strings.
export function oracleCandidates(session: ReplaySession): Map<number, OracleCandidate[]> {
  return new Map(session.batches.map((batch, batchIndex) => {
    const positions = session.batchPositions[batchIndex].results.map(r => r.position);
    const first = Math.min(...positions), last = Math.max(...positions);
    const earlier = [batch.assistantText, ...batch.toolCalls.map(c => JSON.stringify(c.args))];
    const later: string[] = [];
    for (const message of session.messages) {
      if (message.position < first) earlier.push(message.text, ...message.toolArgs.map(a => JSON.stringify(a)));
      if (message.position > last && message.role === "assistant") later.push(message.text, ...message.toolArgs.map(a => JSON.stringify(a)));
    }
    const candidates = batch.toolCalls.flatMap((call, resultIndex) => {
      if (call.spillPath || session.batchPositions[batchIndex].results[resultIndex]?.spilled) return [];
      const text = call.resultText;
      const strings = new Set<string>();
      for (const token of text.matchAll(TOKEN_CLASS)) {
        if (isIdentifierShaped(token[0]) || (/^\d{3,}$/.test(token[0])) || (token[0].includes("/") && (token[0].includes(".") || token[0].startsWith("/")))) strings.add(token[0]);
      }
      for (const number of text.matchAll(/\b\d{3,}\b/g)) strings.add(number[0]);
      for (const error of text.matchAll(/\b(?:error|exception|failed|traceback|panic)\b[:\s-]+([^\r\n]+)/gi)) strings.add(error[1].slice(0, 200));
      return [...strings].filter(s => later.some(t => t.includes(s)) && !earlier.some(t => t.includes(s))).map(s => {
        const offset = text.indexOf(s);
        return { text: s, resultIndex, resultLength: text.length, offset, inMiddle: text.length > 8000 && offset >= 4000 && offset < text.length - 4000 };
      });
    });
    return [batchIndex, candidates];
  }));
}

export function oracleStrings(session: ReplaySession): Map<number, Set<string>> {
  return new Map([...oracleCandidates(session)].map(([index, candidates]) => [index, new Set(candidates.map(c => c.text))]));
}
