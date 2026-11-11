import type { Json, ToolSpec } from "@stewart/kernel";
import type { HealthReport } from "@stewart/code-health";
import type { Tool } from "@stewart/tools";

export const SUBMIT_HEALTH = "submit_health";
export const HEALTH_REPORT = "health_report";

const SUBMIT_HEALTH_SPEC: ToolSpec = {
  name: "submit_health",
  description: "Submit the structured code-health report for the reviewed files. Ends the turn.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            loc: { type: "integer" },
            score: { type: "number" },
            band: { type: "string", enum: ["Green", "Yellow", "Red"] },
          },
          required: ["path", "loc", "score", "band"],
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            line: { type: "integer" },
            smell: { type: "string" },
            severity: { type: "string", enum: ["high", "med", "low"] },
            refactor: { type: "string" },
          },
          required: ["path", "smell", "severity", "refactor"],
        },
      },
      notChecked: { type: "array", items: { type: "string" } },
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            command: { type: "string" },
            status: { type: "string", enum: ["pass", "fail", "not run"] },
            detail: { type: "string" },
          },
          required: ["name", "command", "status", "detail"],
        },
      },
    },
    required: ["files"],
  },
};

const HEALTH_REPORT_SPEC: ToolSpec = {
  name: "health_report",
  description: "Merge all submitted health reports, write the report to scratch and return the rendered text. Orchestrator only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["score", "issues"] },
    },
  },
};

/** `submit_health`: a reviewer's structured report; ends the turn. `handle` records it. */
export function submitHealthTool(handle: (report: HealthReport) => string): Tool {
  return { spec: SUBMIT_HEALTH_SPEC, requiresApproval: false, coreHandled: true, execute: async (args: Json) => handle(args as never) };
}

/** `health_report`: Orchestrator-only merge/render of the submitted reports. */
export function healthReportTool(handle: (args: { mode?: "score" | "issues" }) => string | Promise<string>): Tool {
  return { spec: HEALTH_REPORT_SPEC, requiresApproval: false, coreHandled: true, execute: async (args: Json) => handle(args as never) };
}
