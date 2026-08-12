/**
 * pi-ai repairs orphan tool calls only; providers reject orphan tool results.
 *
 * Open-call tracking is PER TURN: an assistant message replaces the open set
 * with its own toolCall ids. A cumulative seen-set would let an id used
 * validly in an early turn license a later genuine orphan - exactly the
 * id-collision case this exists for.
 *
 * Returns the input array reference when nothing is swept, preserving the
 * no-op / prompt-cache-prefix invariant of
 * doc/specs/2026-08-04-pruner-noop-serialization.md.
 */
export function sweepOrphanToolResults(messages: any[]): { messages: any[]; sweptIds: string[] } {
  let open = new Set<string>();
  const orphanIndices = new Set<number>();
  const sweptIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      open = new Set(
        (msg.content ?? [])
          .filter((c: any) => c.type === "toolCall")
          .map((c: any) => c.id as string),
      );
      continue;
    }
    if (msg.role === "toolResult") {
      if (open.has(msg.toolCallId)) {
        open.delete(msg.toolCallId);
      } else {
        orphanIndices.add(i);
        sweptIds.push(msg.toolCallId);
      }
    }
  }

  if (orphanIndices.size === 0) return { messages, sweptIds: [] };
  return { messages: messages.filter((_, i) => !orphanIndices.has(i)), sweptIds };
}
