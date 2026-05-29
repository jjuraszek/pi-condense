import type { ErrorPurgeConfig } from "./types.js";

/**
 * Replaces the `arguments` body of failed toolCall blocks with a compact stub
 * once the error is old enough to be beyond the cooldown window.
 *
 * Why only the arguments, not the whole toolCall or its toolResult:
 *   - The toolResult content (e.g. "Error: file not found") is small and carries
 *     the failure signal the model needs to understand what went wrong.
 *   - The toolCall block itself must remain so the provider can pair it with its
 *     result and avoid injecting a synthetic "No result provided" error.
 *   - The arguments body is what grows large — failed `write` / `edit` calls
 *     embed the full file content that will never be acted on again.
 *
 * Why the cooldown:
 *   - Gives the model 1–2 turns to retry before context is mutated. Purging
 *     immediately would remove the call detail before the model has had a
 *     chance to see the error and adapt.
 *
 * Turn index is computed internally by counting AssistantMessages in the input.
 * This avoids threading a turn counter through index.ts.
 */
export function purgeErroredArgs(messages: any[], config: ErrorPurgeConfig): any[] {
  // Pass 1: collect errored toolCallIds → the turn index at which the error occurred.
  // Turn index = number of AssistantMessages seen up to and including the one that
  // issued the tool call (ToolResultMessages follow immediately after).
  const erroredAtTurn = new Map<string, number>();
  let turnCount = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      // Count each assistant turn; toolResults referencing the turn come next.
      turnCount++;
    } else if (msg.role === "toolResult" && msg.isError === true) {
      // Record the turn this errored call belongs to for cooldown comparison.
      erroredAtTurn.set(msg.toolCallId, turnCount);
    }
  }

  if (erroredAtTurn.size === 0) return messages;

  const currentTurnIndex = turnCount;

  // Pass 2: rewrite AssistantMessages whose toolCall args should be purged.
  let anyModified = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let contentModified = false;
    const newContent = (msg.content as any[]).map((block) => {
      if (block.type !== "toolCall") return block;

      const errorTurn = erroredAtTurn.get(block.id);
      if (errorTurn === undefined) return block;

      const age = currentTurnIndex - errorTurn;
      if (age < config.cooldownTurns) return block;

      const argBody = JSON.stringify(block.arguments);
      if (argBody.length < config.minArgChars) return block;

      contentModified = true;
      return { ...block, arguments: { _purged: `<purged-errored-args size="${argBody.length}"/>` } };
    });

    if (!contentModified) return msg;
    anyModified = true;
    return { ...msg, content: newContent };
  });

  return anyModified ? result : messages;
}
