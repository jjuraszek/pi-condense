import type { Scenario } from "../scenario";

export default {
  id: "disproved-explanation",
  title: "Disproved explanation",
  tests: "Checks that direct refutation rules out the proposed explanation rather than preserving it as the known cause.",
  history: [
    {
      role: "user",
      text: "Investigate the orbital-ledger absent receipt error."
    },
    {
      role: "assistant",
      text: "A missing shard might explain the absent receipt error. Inspect shard presence.",
      toolCalls: [
        {
          id: "call_disproved-explanation_1",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/disproved-explanation-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_disproved-explanation_1",
      toolName: "read",
      text: "Shard violet is present and readable. The absent receipt error still persists.\n" + Array.from({ length: 60 }, (_, n) => "disproved-explanation invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    }
  ],
  probe: "Is the missing shard the cause of the absent receipt error?",
  mechanical: {},
  judged: {
    oracle: "The assistant proposed a missing shard. Inspection found shard violet present and readable while the absent receipt error persisted.",
    expected: "Rule out the missing-shard explanation and cite the present readable shard with the continuing error."
  }
} satisfies Scenario;
