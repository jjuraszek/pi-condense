import type { Scenario } from "../scenario";

export default {
  id: "correction-then-topic-change",
  title: "Correction across topic change",
  tests: "Checks that the user-corrected queue limit survives an unrelated topic change and overrides the earlier mistaken value.",
  history: [
    {
      role: "user",
      text: "What queue limit should orbital-ledger use?"
    },
    {
      role: "assistant",
      text: "Use queue limit 24."
    },
    {
      role: "user",
      text: "Correction: the queue limit is 42, not 24."
    },
    {
      role: "user",
      text: "Now inspect the unrelated color inventory."
    },
    {
      role: "assistant",
      text: "Reading color inventory.",
      toolCalls: [
        {
          id: "call_correction-then-topic-change_1",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/correction-then-topic-change-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_correction-then-topic-change_1",
      toolName: "read",
      text: "Color inventory: amber slots unchanged.\n" + Array.from({ length: 60 }, (_, n) => "correction-then-topic-change invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    }
  ],
  probe: "Returning to the queue: what limit should we use?",
  mechanical: {
    contains: [
      "42"
    ]
  },
  judged: {
    oracle: "The assistant first said queue limit 24. The user corrected it: the queue limit is 42, not 24. The conversation then moved to color inventory.",
    expected: "Use queue limit 42 and do not assert 24 as current; quoting 24 as rejected is acceptable."
  }
} satisfies Scenario;
