import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: "context_tree_query",
    label: "Query Original Tool History",
    description:
      "Retrieve original tool call results that have been pruned from active context. Pass the short refs from a pruner-summary message to get back the full original outputs.",
    promptSnippet: "Retrieve original pruned tool outputs by short ref",
    promptGuidelines: [
      "When you need the full output of a tool call that was summarized and pruned from context, use context_tree_query with the short refs listed in the relevant pruner-summary message.",
    ],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ description: "One or more short refs or tool call IDs to retrieve" }), {
        description: "List of short refs or toolCallIds to look up",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const foundRecords: Record<string, any> = {};
      const blocks: string[] = [];

      for (const id of params.toolCallIds) {
        const record = indexer.getRecord(id);

        if (!record) {
          blocks.push(`## toolRef: ${id}\n(not found in index — may not have been summarized yet)`);
          continue;
        }

        foundRecords[id] = record;

        const status = record.isError ? "ERROR" : "OK";
        const header = [
          `## toolRef: ${id}`,
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

      const combined = blocks.join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: combined }],
        details: { results: foundRecords },
      };
    },
  });
}
