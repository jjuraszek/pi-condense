import fresh from "./plan-progress-continue";
import type { Scenario } from "../scenario";

export default { ...fresh, id: "plan-progress-continue-paused", seedAgeMinutes: 240, twinOf: fresh.id } satisfies Scenario;
