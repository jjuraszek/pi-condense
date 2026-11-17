import fresh from "./skill-gate-reply";
import type { Scenario } from "../scenario";

export default { ...fresh, id: "skill-gate-reply-paused", seedAgeMinutes: 240, twinOf: fresh.id } satisfies Scenario;
