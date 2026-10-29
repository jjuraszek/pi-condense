import type { Scenario } from "../scenario";

export default {
  id: "failed-fix-not-disproof",
  title: "Failed fix is not disproof",
  tests: "Checks that an unrelated operational failure during a proposed fix does not disprove the original hypothesis.",
  history: [
    {
      role: "user",
      text: "Investigate orbital-ledger replay drift."
    },
    {
      role: "assistant",
      text: "An outdated replay index may cause replay drift. Try rebuilding the index.",
      toolCalls: [
        {
          id: "call_failed-fix-not-disproof_1",
          name: "rebuild_index",
          arguments: {
            path: "/orbital-ledger/notes/failed-fix-not-disproof-1.txt"
          }
        }
      ]
    },
    {
      role: "result",
      toolCallId: "call_failed-fix-not-disproof_1",
      toolName: "rebuild_index",
      text: "Rebuild could not start: synthetic scratch volume is readonly. No index was rebuilt or tested.\n" + Array.from({ length: 60 }, (_, n) => "failed-fix-not-disproof invented ledger row " + String(n).padStart(3, "0") + ": amber pebble balance unchanged.\n").join(""),
      isError: true
    }
  ],
  probe: "Does the failed rebuild disprove the outdated replay index hypothesis?",
  mechanical: {},
  judged: {
    oracle: "The proposed cause was an outdated replay index. A rebuild attempt could not start because the synthetic scratch volume was readonly. The index was neither rebuilt nor tested. The user first asked: 'Investigate orbital-ledger replay drift.' The assistant then proposed: 'An outdated replay index may cause replay drift. Try rebuilding the index.' It called rebuild_index on /orbital-ledger/notes/failed-fix-not-disproof-1.txt (t1 = call_failed-fix-not-disproof_1). The result (isError: true) said: 'Rebuild could not start: synthetic scratch volume is readonly. No index was rebuilt or tested.' It also contained 60 invented ledger rows, numbered 000-059, with the exact template 'failed-fix-not-disproof invented ledger row NNN: amber pebble balance unchanged.' where NNN is the zero-padded row number. The tool call was an attempted fix, not a completed rebuild or a test of the proposed cause; the readonly failure neither verifies nor disproves the hypothesis.",
    expected: "Keep the outdated-index hypothesis open and distinguish the readonly failure from disproof."
  }
} satisfies Scenario;
