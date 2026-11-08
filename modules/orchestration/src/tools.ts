import type { Json } from "@stewart/kernel";
import type { Tool } from "@stewart/tools";
import type { HealthReport } from "@stewart/code-health";

/** Core-provided implementations of the orchestration verbs. */
export interface OrchestrationHandlers {
  dispatch(args: { role: string; task: string; files?: string[]; dependsOn?: string[]; expect?: string; title?: string }, signal: AbortSignal): Promise<string>;
  askUser(args: { question: string; options?: string[] }, signal: AbortSignal): Promise<string>;
  submitPlan(args: { milestones: { title: string; acceptance?: string }[] }): string;
  submitVerdict(args: { verdict: "approve" | "revise"; reasons?: string[] }): string | Promise<string>;
  submitReplacements(args: { replacements: { role: string; agent: string; reason: string }[] }): string;
  submitHealth(args: HealthReport): string;
  healthReport(args: { mode?: "score" | "issues" }): string | Promise<string>;
}

/**
 * Orchestration verbs live in the ToolRegistry like any other tool but are
 * flagged `coreHandled`: they never reach a channel as side effects, and only
 * the roles that list them can call them.
 */
export function orchestrationTools(h: OrchestrationHandlers): Tool[] {
  return [
    {
      spec: {
        name: "dispatch",
        description:
          "Run one unit of work under a role. Returns that role's structured result. Independent dispatches in the same turn run in parallel.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string", description: "role id, e.g. investigator, planner, code-writer" },
            task: { type: "string", description: "self-contained briefing: goal, files, constraints, expected output" },
            title: { type: "string", description: "short label for the UI" },
            files: { type: "array", items: { type: "string" }, description: "files this task will write" },
            dependsOn: { type: "array", items: { type: "string" }, description: "task ids that must finish first" },
            expect: { type: "string", description: "acceptance criterion for the result" },
          },
          required: ["role", "task"],
        },
      },
      requiresApproval: false,
      coreHandled: true,
      parallel: true,
      execute: (args, _p, signal) => h.dispatch(args as never, signal),
    },
    {
      spec: {
        name: "ask_user",
        description: "Ask the user a question. Answer it yourself when the request, plan or earlier results already decide it.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["question"],
        },
      },
      requiresApproval: false,
      awaitsUser: true,
      coreHandled: true,
      execute: (args, _p, signal) => h.askUser(args as never, signal),
    },
    {
      spec: {
        name: "submit_plan",
        description: "Submit the plan for validation. Ends the turn.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            milestones: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { title: { type: "string" }, acceptance: { type: "string" } },
                required: ["title"],
              },
            },
          },
          required: ["milestones"],
        },
      },
      requiresApproval: false,
      coreHandled: true,
      execute: async (args: Json) => h.submitPlan(args as never),
    },
    {
      spec: {
        name: "submit_verdict",
        description: "Approve the plan or ask for a revision with reasons. Ends the turn.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            verdict: { type: "string", enum: ["approve", "revise"] },
            reasons: { type: "array", items: { type: "string" } },
          },
          required: ["verdict"],
        },
      },
      requiresApproval: false,
      coreHandled: true,
      execute: async (args: Json) => h.submitVerdict(args as never),
    },
    {
      spec: {
        name: "submit_replacements",
        description: "Rank free agents for parked roles. Ends the turn.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            replacements: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  role: { type: "string" },
                  agent: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["role", "agent", "reason"],
              },
            },
          },
          required: ["replacements"],
        },
      },
      requiresApproval: false,
      coreHandled: true,
      execute: async (args: Json) => h.submitReplacements(args as never),
    },
    {
      spec: {
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
          },
          required: ["files"],
        },
      },
      requiresApproval: false,
      coreHandled: true,
      execute: async (args: Json) => h.submitHealth(args as never),
    },
    {
      spec: {
        name: "health_report",
        description: "Merge all submitted health reports, write the report to scratch and return the rendered text. Orchestrator only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["score", "issues"] },
          },
        },
      },
      requiresApproval: false,
      coreHandled: true,
      execute: async (args: Json) => h.healthReport(args as never),
    },
  ];
}
