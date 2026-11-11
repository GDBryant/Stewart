import { isHealthCheckRequest } from "@stewart/code-health";
import type { FeatureRuntime, RunFeature } from "@stewart/run-contract";
import { HEALTH_REVIEWER_ROLE, HealthRun } from "./healthRun.js";
import { HEALTH_REPORT, SUBMIT_HEALTH } from "./healthTools.js";

/** Refuse a project health request when the reviewer role is not enabled (nothing could produce the report). */
function preflight(userText: string, rt: FeatureRuntime): string | undefined {
  if (!isHealthCheckRequest(userText)) return undefined;
  if (rt.config.roles.some((r) => r.id === HEALTH_REVIEWER_ROLE && r.enabled)) return undefined;
  return `${HEALTH_REVIEWER_ROLE} is not enabled; enable it in roles.yaml or rerun setup`;
}

/** The code-health feature, registered by the app: `RunRuntime.features = [healthCheckFeature]`. */
export const healthCheckFeature: RunFeature = {
  id: "health-check",
  terminalTools: [SUBMIT_HEALTH],
  orchestratorDefaultTools: [HEALTH_REPORT],
  requiredRoleTools: {
    orchestrator: ["ListCodeFiles", HEALTH_REPORT],
    [HEALTH_REVIEWER_ROLE]: ["ListCodeFiles", SUBMIT_HEALTH, "CodeMetrics", "RunTerminal"],
  },
  preflight,
  createRun: (rt, view) => new HealthRun(rt, view),
};
