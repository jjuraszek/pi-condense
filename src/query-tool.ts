import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import { QUERY_TOOL_NAME } from "./types.js";

// Legacy records (persisted before resultTimestamp existed) have no timestamp
// to disambiguate. Do NOT mint an `id@legacy` string: it is occurrence-key-
// SHAPED but not a real key — parseOccKey would treat "legacy" as part of a
// literal id, so echoing it back into context_tree_query would fail lookup.
// Label with the bare id and call out the ambiguity in the block body instead.
function occurrenceLabel(id: string, resultTimestamp: number | undefined): string {
  return resultTimestamp === undefined ? id : `${id}@${resultTimestamp}`;
}

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: QUERY_TOOL_NAME,
    label: "Query Original Tool History",
    description:
      "Retrieve original tool call results that have been pruned from active context. Pass the short refs listed in a pruner-summary message, e.g. context_tree_query({ toolCallIds: [\"t12\", \"t3\"] }), to get back the full original outputs. A raw id that was reused returns every occurrence, each labelled id@timestamp.",
    promptSnippet: "Retrieve original pruned tool outputs by short ref",
    promptGuidelines: [
      "When you need the full output of a tool call that was summarized and pruned from context, use context_tree_query with the short refs listed in the relevant pruner-summary message.",
    ],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String(), {
        description: 'Required. One or more short refs (e.g. "t12") or raw tool call IDs from a pruner-summary message. A reused raw id returns every occurrence, each labelled id@timestamp.',
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const foundRecords: Record<string, any> = {};
      const blocks: string[] = [];

      for (const id of params.toolCallIds) {
        const records = indexer.getRecordsForId(id);

        if (records.length === 0) {
          blocks.push(`## toolRef: ${id}\n(not found in index — may not have been summarized yet)`);
          continue;
        }

        for (const record of records) {
          // A reused provider id denotes several occurrences; return all of
          // them rather than silently picking one. `tN` refs stay 1:1.
          const label = records.length > 1 ? occurrenceLabel(id, record.resultTimestamp) : id;

          foundRecords[label] = record;

          const status = record.isError ? "ERROR" : "OK";
          const header = [
            `## toolRef: ${label}`,
            ...(records.length > 1 && record.resultTimestamp === undefined ? ["Occurrence: legacy (no resultTimestamp)"] : []),
            `Tool: ${record.toolName}`,
            `Args: ${JSON.stringify(record.args, null, 2)}`,
            `Status: ${status}`,
            `Turn: ${record.turnIndex}`,
            "",
          ].join("\n");

          let raw = record.resultText;
          if (record.spillPath) {
            try {
              raw = await readFile(record.spillPath, "utf-8");
            } catch (err) {
              console.error(`context_tree_query: failed to read spilled output at ${record.spillPath}:`, err);
              raw = record.resultPreview ?? "(spilled output unavailable — sidecar file missing)";
            }
          }

          const t = truncateHead(raw, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          let body = t.content;
          if (t.truncated) {
            body += `\n[Output truncated: ${t.outputLines}/${t.totalLines} lines shown]`;
          }

          blocks.push(`${header}\n${body}`);
        }
      }

      const combined = blocks.join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: combined }],
        details: { results: foundRecords },
      };
    },
  });
}
