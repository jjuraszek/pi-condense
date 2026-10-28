import type { Scenario } from "../scenario";

export default {
  id: "repeated-attempts-among-unrelated",
  title: "Repeated attempts among unrelated work",
  tests: "Checks recovery of all three task A attempts interleaved with unrelated task B evidence, without collapsing distinct approaches.",
  history: [
    {
      role: "user",
      text: "Track task A receipt investigation and unrelated task B color inventory."
    },
    {
      role: "assistant",
      text: "Inspect A-SCAN.",
      toolCalls: [
        {
          id: "call_repeated-attempts-among-unrelated_1",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/repeated-attempts-among-unrelated-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_repeated-attempts-among-unrelated_1",
      toolName: "read",
      text: "A-SCAN: scan found no receipt gap.\n" + Array.from({ length: 60 }, (_, n) => "A-SCAN invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    },
    {
      role: "assistant",
      text: "Inspect B-COLOR.",
      toolCalls: [
        {
          id: "call_repeated-attempts-among-unrelated_2",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/repeated-attempts-among-unrelated-2.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_repeated-attempts-among-unrelated_2",
      toolName: "read",
      text: "B-COLOR: amber inventory unchanged.\n" + Array.from({ length: 60 }, (_, n) => "B-COLOR invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    },
    {
      role: "assistant",
      text: "Inspect A-REINDEX.",
      toolCalls: [
        {
          id: "call_repeated-attempts-among-unrelated_3",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/repeated-attempts-among-unrelated-3.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_repeated-attempts-among-unrelated_3",
      toolName: "read",
      text: "A-REINDEX: index rebuild completed; drift persisted.\n" + Array.from({ length: 60 }, (_, n) => "A-REINDEX invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    },
    {
      role: "assistant",
      text: "Inspect B-COUNT.",
      toolCalls: [
        {
          id: "call_repeated-attempts-among-unrelated_4",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/repeated-attempts-among-unrelated-4.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_repeated-attempts-among-unrelated_4",
      toolName: "read",
      text: "B-COUNT: inventory count is stable.\n" + Array.from({ length: 60 }, (_, n) => "B-COUNT invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    },
    {
      role: "assistant",
      text: "Inspect A-REPLAY.",
      toolCalls: [
        {
          id: "call_repeated-attempts-among-unrelated_5",
          name: "read",
          arguments: {
            path: "/orbital-ledger/notes/repeated-attempts-among-unrelated-5.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_repeated-attempts-among-unrelated_5",
      toolName: "read",
      text: "A-REPLAY: replay reproduced drift.\n" + Array.from({ length: 60 }, (_, n) => "A-REPLAY invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: false
    }
  ],
  probe: "What approaches were tried on task A, and what happened? Recover the evidence for each.",
  mechanical: {
    contains: [
      "A-SCAN",
      "A-REINDEX",
      "A-REPLAY"
    ],
    recovers: [
      {
        id: "call_repeated-attempts-among-unrelated_1",
        evidence: "A-SCAN"
      },
      {
        id: "call_repeated-attempts-among-unrelated_3",
        evidence: "A-REINDEX"
      },
      {
        id: "call_repeated-attempts-among-unrelated_5",
        evidence: "A-REPLAY"
      }
    ]
  }
} satisfies Scenario;
