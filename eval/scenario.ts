import { CURRENT_SESSION_VERSION, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type SeedTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: Omit<ToolCall, "type">[]; stopReason?: "error" | "aborted" }
  | { role: "result"; toolCallId: string; toolName: string; text: string; isError?: boolean };

export type Scenario = {
  id: string;
  title: string;
  tests: string;
  history: SeedTurn[];
  probe: string;
  seedAgeMinutes?: number;
  twinOf?: string;
  unsummarizedIds?: string[];
  mechanical: { contains?: string[]; recovers?: { id: string; evidence: string }[] };
  judged?: { oracle: string; expected: string };
};

export function seedEntries(history: SeedTurn[], endMs = Date.now()): FileEntry[] {
  const epoch = endMs - Math.max(0, history.length - 1) * 1000;
  const entries: FileEntry[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id: "seed-session", timestamp: new Date(epoch).toISOString(), cwd: "/orbital-ledger" }];
  history.forEach((turn, i) => {
    const timestamp = epoch + i * 1000;
    let message: UserMessage | AssistantMessage | ToolResultMessage;
    if (turn.role === "user") message = { role: "user", content: [{ type: "text", text: turn.text }], timestamp };
    else if (turn.role === "result") message = { role: "toolResult", toolCallId: turn.toolCallId, toolName: turn.toolName, content: [{ type: "text", text: turn.text }], isError: turn.isError ?? false, timestamp };
    else message = {
      role: "assistant", content: [...(turn.text ? [{ type: "text" as const, text: turn.text }] : []), ...(turn.toolCalls ?? []).map(c => ({ type: "toolCall" as const, ...c }))],
      api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", timestamp,
      stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "toolUse" : "stop"),
      // Synthetic history has no measured provider usage.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    entries.push({ type: "message", id: `seed-message-${i + 1}`, parentId: i === 0 ? null : `seed-message-${i}`, timestamp: new Date(timestamp).toISOString(), message });
  });
  return entries;
}
