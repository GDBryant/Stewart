import type { ToolCall } from "@stewart/kernel";
import { approvalPrompt, type Interaction, type PromptTag } from "@stewart/interaction";
import { Grants } from "./grants.js";
import { categoryOf, type ToolPreview } from "./preview.js";

/** Structurally identical to `ApprovalDecision` in `@stewart/agent-loop` (declared here because agent-loop sits above this layer). */
export type PermissionDecision = { kind: "approved" } | { kind: "rejected"; reason: string };

export interface PermissionRequest {
  tool: string;
  args: unknown;
  preview: ToolPreview | null;
}

export type ApproveFn = (call: ToolCall, preview: ToolPreview | null, meta?: { roleId?: string; taskId?: string }) => Promise<PermissionDecision>;

/** Where grant policy meets prompting: session grants + run grants decide; otherwise one approval card on the Interaction. */
export class Permissions {
  private session = new Grants();

  constructor(private readonly interaction: Pick<Interaction, "ask">) {}

  /** `allow` when a run or session grant covers the call; any internal error yields `ask` (fail closed). */
  decide(req: PermissionRequest, runGrants: Grants): "allow" | "ask" {
    try {
      const cat = categoryOf(req.preview) ?? "OTHER";
      return runGrants.isGranted(cat, req.preview) || this.session.isGranted(cat, req.preview) ? "allow" : "ask";
    } catch {
      return "ask";
    }
  }

  /** Shows the approval card; `chat` records a run grant, `always` a session grant, withdrawn/deny → rejected "denied by user". */
  async ask(req: PermissionRequest, runGrants: Grants, tag: PromptTag, signal?: AbortSignal): Promise<PermissionDecision> {
    const cat = categoryOf(req.preview) ?? "OTHER";
    const o = await this.interaction.ask(approvalPrompt(req.tool, req.args, cat), tag, signal);
    const d = o.kind === "answered" ? o.value : "deny";
    if (d === "deny") return { kind: "rejected", reason: "denied by user" };
    if (d === "chat") runGrants.record("chat", cat, req.preview);
    if (d === "always") this.session.record("always", cat, req.preview);
    return { kind: "approved" };
  }

  /** Per-run approval function handed to the agent loop as `rt.approve`; `runGrants` defaults to a fresh set. */
  gate(runId: string, signal: AbortSignal, runGrants = new Grants()): ApproveFn {
    return async (call, preview, meta) => {
      const req = { tool: call.name, args: call.arguments, preview };
      if (this.decide(req, runGrants) === "allow") return { kind: "approved" };
      return this.ask(req, runGrants, { runId, roleId: meta?.roleId, taskId: meta?.taskId }, signal);
    };
  }
}
