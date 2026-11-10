import { occKey, resultTimestampOf } from "./occurrence-key.js";
import { QUERY_TOOL_NAME } from "./types.js";
import type { ErrorPurgeConfig } from "./types.js";

// Keep short paths and commands readable while reclaiming large completed-call bodies.
const PURGE_STRING_MIN_CHARS = 200;

function shrinkStrings(
  value: unknown,
  marker: (size: number) => string = (size) => `<purged-errored-args size="${size}"/>`,
): [unknown, boolean] {
  if (typeof value === "string") {
    if (value.length > PURGE_STRING_MIN_CHARS) return [marker(value.length), true];
    return [value, false];
  }
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const [next, changed] = shrinkStrings(value[i], marker);
      if (!changed) continue;
      out ??= value.slice();
      out[i] = next;
    }
    return out ? [out, true] : [value, false];
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const key of Object.keys(object)) {
      const [next, changed] = shrinkStrings(object[key], marker);
      if (!changed) continue;
      // Spread creates own data properties, including JSON's possible __proto__ key.
      out ??= { ...object };
      out[key] = next;
    }
    return out ? [out, true] : [value, false];
  }
  return [value, false];
}

// The two markers shrinkStrings writes; only the summarized one carries a ref.
const PURGE_MARKER = /^\s*<purged-(?:errored-args size="\d+"|args size="\d+" ref="([^"]+)")\/>\s*$/;

function collectMarkerLeaves(value: unknown, path: string, found: string[]): void {
  if (typeof value === "string") {
    const match = PURGE_MARKER.exec(value);
    if (!match) return;
    found.push(
      match[1] === undefined
        ? `- ${path}: this placeholder has no ref; rewrite it in full.`
        : `- ${path}: recover the original with ${QUERY_TOOL_NAME}({ toolCallIds: ["${match[1]}"] }), or rewrite it in full.`,
    );
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectMarkerLeaves(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectMarkerLeaves(item, path ? `${path}.${key}` : key, found);
  }
}

/**
 * A model re-issuing a purged call can copy the marker as the argument.
 * Returns the refusal for a call with a string argument that is only a marker; a marker inside longer text passes.
 */
export function purgeMarkerBlockReason(input: Record<string, unknown>): string | undefined {
  const found: string[] = [];
  collectMarkerLeaves(input, "", found);
  if (found.length === 0) return undefined;
  return [
    "pi-condense blocked this call. A purge placeholder marks where a long argument was removed from context; it is not the argument's value.",
    ...found,
    "Call the tool again with the real value.",
  ].join("\n");
}

/**
 * Shrinks summarized arguments immediately and errored arguments after cooldown.
 * Keys and JSON types survive pi-ai grammar validation during replay.
 */
export function purgeErroredArgs(
  messages: any[],
  config: ErrorPurgeConfig,
  summarizedRefs: ReadonlyMap<string, string> = new Map(),
): any[] {
  if (!config.enabled) return messages;

  const targets = new Map<number, Map<string, { turn: number; ref?: string }>>();
  const open = new Map<string, { assistantIndex: number; turn: number }>();
  let turnCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      turnCount++;
      open.clear();
      for (const block of msg.content) {
        if (block.type === "toolCall") open.set(block.id, { assistantIndex: i, turn: turnCount });
      }
    } else if (msg.role === "toolResult") {
      const paired = open.get(msg.toolCallId);
      if (!paired) continue;
      open.delete(msg.toolCallId);
      const ref = summarizedRefs.get(occKey(msg.toolCallId, resultTimestampOf(msg.timestamp)));
      if (ref === undefined && msg.isError !== true) continue;
      let blocks = targets.get(paired.assistantIndex);
      if (!blocks) targets.set(paired.assistantIndex, blocks = new Map());
      blocks.set(msg.toolCallId, { turn: paired.turn, ref });
    } else {
      open.clear();
    }
  }

  if (targets.size === 0) return messages;

  // Pass 2: rewrite AssistantMessages whose toolCall args should be purged.
  let anyModified = false;
  const result = messages.map((msg, assistantIndex) => {
    const targetsForTurn = targets.get(assistantIndex);
    if (!targetsForTurn) return msg;

    let contentModified = false;
    const newContent = (msg.content as any[]).map((block) => {
      if (block.type !== "toolCall") return block;

      const target = targetsForTurn.get(block.id);
      if (!target) return block;
      if (target.ref === undefined && turnCount - target.turn < config.cooldownTurns) return block;

      const argBody = JSON.stringify(block.arguments);
      if (argBody.length < config.minArgChars) return block;

      const [shrunk, changed] = shrinkStrings(
        block.arguments,
        target.ref === undefined ? undefined : (size) => `<purged-args size="${size}" ref="${target.ref}"/>`,
      );
      if (!changed) return block;

      contentModified = true;
      return { ...block, arguments: shrunk };
    });

    if (!contentModified) return msg;
    anyModified = true;
    return { ...msg, content: newContent };
  });

  return anyModified ? result : messages;
}
