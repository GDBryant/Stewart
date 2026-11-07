import type { Json } from "@stewart/kernel";
import { type Tool } from "@stewart/tools";

export interface RecoveryPlan {
  subtasks: { description: string; outputFile: string; maxTurns?: number }[];
  finalFile?: string;
  advice?: string;
}

/** Validates `submit_recovery` args; throws with a resubmit-able error. */
export function parseRecoveryArgs(args: Json, limits: { maxSubTasks: number; ceiling: number }): RecoveryPlan {
  const raw = args.subtasks;
  if (!Array.isArray(raw)) throw new Error("'subtasks' must be an array");
  if (raw.length < 2 || raw.length > limits.maxSubTasks) {
    throw new Error(`'subtasks' must have 2..${limits.maxSubTasks} entries (got ${raw.length})`);
  }
  const subtasks = raw.map((s, i) => {
    if (typeof s !== "object" || s === null) throw new Error(`subtask ${i + 1}: not an object`);
    const o = s as Record<string, unknown>;
    const description = o.description;
    if (typeof description !== "string" || !description.trim()) throw new Error(`subtask ${i + 1}: 'description' required`);
    const outputFile = o.output_file;
    if (typeof outputFile !== "string" || !outputFile.trim()) throw new Error(`subtask ${i + 1}: 'output_file' required`);
    if (/[/\\]/.test(outputFile) || outputFile.includes("..") || outputFile === ".") {
      throw new Error(`subtask ${i + 1}: 'output_file' must be a bare file name (got '${outputFile}')`);
    }
    let maxTurns: number | undefined;
    if (o.max_turns !== undefined) {
      if (typeof o.max_turns !== "number" || !Number.isInteger(o.max_turns) || o.max_turns < 1 || o.max_turns > limits.ceiling) {
        throw new Error(`subtask ${i + 1}: 'max_turns' must be an integer 1..${limits.ceiling}`);
      }
      maxTurns = o.max_turns;
    }
    return { description: description.trim(), outputFile, maxTurns };
  });
  const finalFile = args.final_file;
  if (finalFile !== undefined && (typeof finalFile !== "string" || !finalFile.trim())) {
    throw new Error("'final_file' must be a project path");
  }
  const advice = args.advice;
  return { subtasks, finalFile: typeof finalFile === "string" ? finalFile.trim() : undefined, advice: typeof advice === "string" ? advice : undefined };
}

export function submitRecoveryTool(onSubmit?: (args: Json) => string): Tool {
  return {
    spec: {
      name: "submit_recovery",
      description:
        "Submit the split plan for a faulted task: 2..N sub-tasks, each writing its own output_file. Ends the turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          subtasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string" },
                output_file: { type: "string", description: "bare file name under the task scratch dir" },
                max_turns: { type: "integer" },
              },
              required: ["description", "output_file"],
            },
          },
          final_file: { type: "string", description: "project path the sub-task outputs are assembled into" },
          advice: { type: "string" },
        },
        required: ["subtasks"],
      },
    },
    requiresApproval: false,
    coreHandled: true,
    execute: async (args) => onSubmit?.(args) ?? "Recovery plan recorded.",
  };
}
