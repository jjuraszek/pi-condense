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
    oracle: "The assistant proposed a missing shard. Inspection found shard violet present and readable while the absent receipt error persisted. The user first asked: 'Investigate the orbital-ledger absent receipt error.' Before inspection the assistant said: 'A missing shard might explain the absent receipt error. Inspect shard presence.' It called read on /orbital-ledger/notes/disproved-explanation-1.txt (t1 = call_disproved-explanation_1). The result (isError: false) said: 'Shard violet is present and readable. The absent receipt error still persists.' It also contained 60 invented ledger rows, numbered 000-059, with the exact template 'disproved-explanation invented ledger row NNN: amber pebble balance unchanged.' where NNN is the zero-padded row number. The observation refutes the proposed missing-shard explanation; it does not identify another cause or show the error resolved.",
    expected: "Rule out the missing-shard explanation and cite the present readable shard with the continuing error."
  }
} satisfies Scenario;
