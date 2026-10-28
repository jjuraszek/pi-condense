import type { Scenario } from "../scenario";

export default {
  id: "mid-result-fact",
  title: "Middle-of-result fact",
  tests: "Checks recovery of a setting buried in the middle of a long fictional file, beyond both preview windows.",
  history: [
    {
      role: "user",
      text: "Inspect the orbital-ledger retry settings."
    },
    {
      role: "assistant",
      text: "Reading the retry settings file.",
      toolCalls: [
        {
          id: "call_mid-result-fact_1",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/mid-result-fact-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_mid-result-fact_1",
      toolName: "read",
      text: "x".repeat(6000) + "retry_window_ms=7319" + "y".repeat(5980),
      isError: false
    }
  ],
  probe: "What is the configured retry window in milliseconds? Recover the original evidence.",
  mechanical: {
    contains: [
      "7319"
    ],
    recovers: [
      {
        id: "call_mid-result-fact_1",
        evidence: "retry_window_ms=7319"
      }
    ]
  }
} satisfies Scenario;
