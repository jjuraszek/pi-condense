import type { Scenario } from "../scenario";

export default {
  id: "unverified-hypothesis",
  title: "Unverified hypothesis",
  tests: "Checks that an unchecked proposed cause stays a hypothesis after unrelated evidence is summarized.",
  history: [
    {
      role: "user",
      text: "Investigate the orbital-ledger delayed receipt."
    },
    {
      role: "assistant",
      text: "A stale checkpoint might cause the delayed receipt. I have not checked it. Reading unrelated color inventory only.",
      toolCalls: [
        {
          id: "call_unverified-hypothesis_1",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/unverified-hypothesis-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_unverified-hypothesis_1",
      toolName: "read",
      text: "Color inventory: amber bins stable. No checkpoint inspection ran.\n" + Array.from({ length: 60 }, (_, n) => "unverified-hypothesis invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    }
  ],
  probe: "What do we actually know about the cause of the delayed receipt?",
  mechanical: {},
  judged: {
    oracle: "The assistant proposed a stale checkpoint as a possible cause of the delayed receipt. No checkpoint check ran; only unrelated color inventory was read.",
    expected: "Present the stale checkpoint as unverified, not an established cause."
  }
} satisfies Scenario;
