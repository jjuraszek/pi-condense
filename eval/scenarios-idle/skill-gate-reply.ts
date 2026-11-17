import type { Scenario } from "../scenario";

const skill = `# Synthetic pi-gauntlet maintenance skill
1. Read the segment inventory without changing it.
2. Ask for a letter: A approves the AMBER_INSPECT step; B approves the COBALT_DRAFT step; C cancels with the SILVER_STOP step.
3. On A, describe an inspect-only check of the segment manifest. Do not draft a replacement.
4. On B, draft a replacement manifest plan without applying it. Do not run the inspect-only step.
5. On C, stop without inspecting or drafting.
Name the chosen step's literal token in your next reply. Each letter authorizes only its own step.`;
const inventory = "The synthetic orbital-ledger inventory contains a violet segment. No replacement or inspection has run.\n" + Array.from({ length: 60 }, (_, n) => `Invented inventory row ${String(n).padStart(3, "0")}: amber pebble balance unchanged.\n`).join("");
const question = "Which next step do you approve: A, B, or C?";

export default {
  id: "skill-gate-reply",
  title: "Skill approval after an idle pause",
  tests: "Checks that a one-letter reply selects the step prescribed by a protected synthetic skill, not another approval branch.",
  history: [
    { role: "user", text: "Follow the synthetic maintenance skill and ask before the next step." },
    { role: "assistant", toolCalls: [
      { id: "call_skill", name: "read", arguments: { path: "/orbital-ledger/skills/maintenance/SKILL.md" } },
      { id: "call_inventory", name: "read", arguments: { path: "/orbital-ledger/inventory.txt" } },
    ] },
    { role: "result", toolCallId: "call_skill", toolName: "read", text: skill },
    { role: "result", toolCallId: "call_inventory", toolName: "read", text: inventory },
    { role: "assistant", text: question },
  ],
  probe: "B",
  mechanical: { contains: ["COBALT_DRAFT"] },
  judged: {
    oracle: `The user requested the synthetic maintenance skill and an approval question. A protected read of /orbital-ledger/skills/maintenance/SKILL.md returned this entire skill: ${skill}\nAn ordinary read of /orbital-ledger/inventory.txt returned: ${inventory}\nThe assistant asked: ${question}\nThe user replied B. No inspection or replacement has run. The subject's only tool is context_tree_query; score its reply text, not a file write.`,
    expected: "Take COBALT_DRAFT: draft or describe a replacement manifest plan without applying it. Do not take AMBER_INSPECT or SILVER_STOP as the approved next step, and do not claim that replacement has already run.",
  },
} satisfies Scenario;
