import type { Clock, HostPort, IdGen } from "./ports.js";
import { EventBus } from "./events.js";
import type { AgentDef } from "./config/schema.js";
import { ManagedChannel } from "./channels/registry.js";
import type { ChatMessage } from "./channels/types.js";
import { DEFAULT_CAPS } from "./channels/types.js";
import { projectTools } from "./tools/builtins.js";
import { ProjectPaths } from "./tools/projectPaths.js";
import { Grants, type GrantDecision } from "./tools/approvals.js";
import { categoryOf } from "./tools/types.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type ApprovalDecision, type ToolsMode } from "./tools/toolLoop.js";

export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  controller: AbortController;
  startedAt: number;
  messages: ChatMessage[];
  costUsd: number;
}

export interface RunDeps {
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: EventBus;
}

/**
 * Owns runs for one project. Direct-mode runs stream through a ToolLoop
 * (tools + approvals); orchestrated runs plug in here at M7.
 */
export class RunManager {
  private runs = new Map<string, Run>();
  private approvals = new Map<string, (d: GrantDecision) => void>();
  private answers = new Map<string, (a: string) => void>();
  private sessionGrants = new Grants();

  constructor(private deps: RunDeps) {}

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  cancel(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || r.status !== "running") return false;
    r.controller.abort();
    r.status = "cancelled";
    return true;
  }

  approve(approvalId: string, decision: GrantDecision): boolean {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return false;
    this.approvals.delete(approvalId);
    resolve(decision);
    return true;
  }

  answer(questionId: string, answer: string): boolean {
    const resolve = this.answers.get(questionId);
    if (!resolve) return false;
    this.answers.delete(questionId);
    resolve(answer);
    return true;
  }

  /** Direct-mode run: stream one agent through the tool loop. */
  async direct(projectId: string, channel: ManagedChannel, agent: AgentDef, text: string, images?: string[]): Promise<Run> {
    const run: Run = {
      id: this.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      messages: [{ role: "user", content: text, images }],
      costUsd: 0,
    };
    this.runs.set(run.id, run);
    const bus = this.deps.bus;
    bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80) });
    void this.drive(run, channel, agent).catch((e) => {
      if (run.status === "running") run.status = "failed";
      bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  }

  private async drive(run: Run, channel: ManagedChannel, agent: AgentDef): Promise<void> {
    const bus = this.deps.bus;
    const paths = await ProjectPaths.forProject(this.deps.host);
    const registry = projectTools(this.deps.host, paths);
    const runGrants = new Grants();
    const runId = run.id;
    const gate = async (call: { name: string; arguments: Record<string, unknown> }, preview: import("./tools/types.js").ToolPreview | null): Promise<ApprovalDecision> => {
      const cat = categoryOf(preview) ?? "OTHER";
      if (runGrants.isGranted(cat, preview) || this.sessionGrants.isGranted(cat, preview)) return { kind: "approved" };
      const approvalId = this.deps.ids.next("appr");
      return new Promise<ApprovalDecision>((resolve) => {
        this.approvals.set(approvalId, (d) => {
          if (d === "deny") resolve({ kind: "rejected", reason: "denied by user" });
          else {
            if (d === "chat") runGrants.record("chat", cat, preview);
            if (d === "always") this.sessionGrants.record("always", cat, preview);
            resolve({ kind: "approved" });
          }
        });
        bus.emit({ kind: "approval.request", runId, approvalId, tool: call.name, args: call.arguments, category: cat });
      });
    };
    const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
    const loop = new ToolLoop(channel, registry, gate, DEFAULT_LIMITS, this.deps.clock, undefined, new Set(), mode);
    const listener = {
      onText: (t: string) => bus.emit({ kind: "text_delta", runId, seq: 0, text: t }),
      onReasoning: (t: string) => bus.emit({ kind: "reasoning_delta", runId, seq: 0, text: t }),
      onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) =>
        bus.emit({ kind: "tool.request", runId, callId: call.id, tool: call.name, args: call.arguments, category: call.name }),
      onToolOutcome: (call: { id: string }, outcome: { kind: string }) =>
        bus.emit({ kind: "tool.outcome", runId, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind }),
    };
    try {
      const result = await loop.run(agent.model, run.messages, listener, run.controller.signal);
      run.messages = [...result.base, ...result.messages];
      if (result.kind === "failed") {
        run.status = "failed";
        bus.emit({ kind: "run.finished", runId, status: "failed", error: result.message });
        return;
      }
      if (result.kind === "turn_limit") {
        run.status = "interrupted";
        bus.emit({ kind: "run.finished", runId, status: "stopped", error: "turn limit reached" });
        return;
      }
      if (run.status === "running") run.status = "done";
      bus.emit({ kind: "run.finished", runId, status: run.status === "cancelled" ? "cancelled" : "done" });
    } catch (e) {
      if (e instanceof RunCancelledError || run.controller.signal.aborted) {
        run.status = "cancelled";
        if (e instanceof RunCancelledError) run.messages = e.transcript;
        bus.emit({ kind: "run.finished", runId, status: "cancelled" });
        return;
      }
      throw e;
    }
  }
}
