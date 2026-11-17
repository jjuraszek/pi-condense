import type { Scenario, SeedTurn } from "../scenario";

const tasks = ["AMBER_SCAN", "VIOLET_COMPARE", "COBALT_REPAIR", "SILVER_VERIFY"];
// Preserve the tracker tools' status glyphs and text layout in synthetic outputs.
const planStatus = (current: number) => `Plan: ${current}/4 done (1 in progress, ${3 - current} pending)\n\n`
  + tasks.map((name, i) => `  ${i < current ? "\u2713" : i === current ? "\u2192" : "\u25cb"} [${i}] ${name}`).join("\n");
const phaseStatus = (context: number) => `Phases:\n  \u2713 brainstorm\n  \u2713 plan\n  \u2192 implement\n  \u25cb verify\n  \u25cb ship\nContext: ${context.toFixed(1)}% of window`;
const inventory = (label: string) => `${label}: synthetic segment inventory; no task completion is asserted by this read.\n`
  + Array.from({ length: 60 }, (_, n) => `${label} invented row ${String(n).padStart(3, "0")}: amber pebble balance unchanged.\n`).join("");

const history: SeedTurn[] = [
  { role: "user", text: "Follow the recorded plan and phase progress. On continuation, name the task the latest plan tracker marks in progress and describe the next action for that task. Do not restart completed tasks or advance pending tasks." },
  { role: "assistant", toolCalls: [
    { id: "call_plan_earlier", name: "plan_tracker", arguments: { action: "status" } },
    { id: "call_phase_earlier", name: "phase_tracker", arguments: { action: "status" } },
    { id: "call_progress_inventory", name: "read", arguments: { path: "/orbital-ledger/progress-inventory.txt" } },
  ] },
  { role: "result", toolCallId: "call_plan_earlier", toolName: "plan_tracker", text: planStatus(0) },
  { role: "result", toolCallId: "call_phase_earlier", toolName: "phase_tracker", text: phaseStatus(10) },
  { role: "result", toolCallId: "call_progress_inventory", toolName: "read", text: inventory("Initial inventory") },
  { role: "assistant", text: "The initial progress snapshot is recorded." },
  { role: "user", text: "The worker has advanced the plan. Read the current tracker state." },
  { role: "assistant", toolCalls: [
    { id: "call_plan_middle", name: "plan_tracker", arguments: { action: "status" } },
    { id: "call_phase_middle", name: "phase_tracker", arguments: { action: "status" } },
  ] },
  { role: "result", toolCallId: "call_plan_middle", toolName: "plan_tracker", text: planStatus(1) },
  { role: "result", toolCallId: "call_phase_middle", toolName: "phase_tracker", text: phaseStatus(20) },
  { role: "assistant", text: "The refreshed progress snapshot is recorded." },
  { role: "user", text: "The worker has advanced the plan again. Inspect the inventory, then read the latest tracker state before continuing." },
  { role: "assistant", toolCalls: [
    { id: "call_progress_work", name: "read", arguments: { path: "/orbital-ledger/current-inventory.txt" } },
  ] },
  { role: "result", toolCallId: "call_progress_work", toolName: "read", text: inventory("Current inventory") },
  { role: "assistant", toolCalls: [
    { id: "call_plan_latest", name: "plan_tracker", arguments: { action: "status" } },
    { id: "call_phase_latest", name: "phase_tracker", arguments: { action: "status" } },
  ] },
  { role: "result", toolCallId: "call_plan_latest", toolName: "plan_tracker", text: planStatus(2) },
  { role: "result", toolCallId: "call_phase_latest", toolName: "phase_tracker", text: phaseStatus(30) },
  { role: "assistant", text: "The run stopped before I could report the latest tracker state.", stopReason: "error" },
];

export default {
  id: "plan-progress-continue",
  title: "Workflow progress after an idle pause",
  tests: "Checks continuation from the latest tracker state across summarized, zero-summary, and interrupted partly summarized chains with unprotected trackers.",
  history,
  unsummarizedIds: ["call_plan_middle", "call_phase_middle", "call_plan_latest", "call_phase_latest"],
  probe: "Continue.",
  mechanical: { contains: ["COBALT_REPAIR"] },
  judged: {
    oracle: `This synthetic pi-gauntlet session follows the recorded plan. Here is the complete seeded history: ${JSON.stringify(history)}\nThe latest plan snapshot marks AMBER_SCAN and VIOLET_COMPARE complete, COBALT_REPAIR in progress, and SILVER_VERIFY pending. The phase remains implement. The run ended with an interrupted text-only reply, and the user now says Continue. The subject can only call context_tree_query; score its reply text, not an actual file change. No repair or verification result is provided.`,
    expected: "Resume COBALT_REPAIR in the implement phase: name it as the current task and describe continuing its repair work. Do not restart AMBER_SCAN or VIOLET_COMPARE, advance to SILVER_VERIFY, or claim a repair or verification has already succeeded.",
  },
} satisfies Scenario;
