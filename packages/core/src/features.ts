import { healthCheckFeature } from "@stewart/health-check";
import { requiredRoleTools, type RunFeature } from "@stewart/run-contract";

/** Product features plugged into orchestrated runs; orchestration and runs never import a feature. */
export const RUN_FEATURES: readonly RunFeature[] = [healthCheckFeature];

/** Tools each shipped role must hold, contributed by `RUN_FEATURES`; unioned into stale roles.yaml at load. */
export const FEATURE_ROLE_TOOLS = requiredRoleTools(RUN_FEATURES);
