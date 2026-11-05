import type { Clock, Fetcher, HostPort, IdGen } from "./ports.js";
import { EventBus, type EventSink } from "./events.js";
import type { ChannelDef, AgentDef, Settings } from "./config/schema.js";
import { ManagedChannel } from "./channels/registry.js";
import type { ChannelAdapter, ChatMessage } from "./channels/types.js";
import { DEFAULT_CAPS } from "./channels/types.js";

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
 * Owns runs for one project. M1: direct single-agent streaming + cancel.
 * Orchestrated runs (RoleRunner/Orchestrator) plug in here at M7.
 */
export class RunManager {
  private runs = new Map<string, Run>();
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

  /** Direct-mode run: stream one agent reply, coalescing text deltas. */
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
    void this.drive(run, channel, agent, text, images).catch((e) => {
      if (run.status === "running") run.status = "failed";
      bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  }

  private async drive(run: Run, channel: ManagedChannel, agent: AgentDef, text: string, images?: string[]): Promise<void> {
    const bus = this.deps.bus;
    let assistant = "";
    try {
      for await (const ev of channel.chat({
        model: agent.model,
        messages: [{ role: "user", content: text, images }],
        temperature: agent.temperature,
        signal: run.controller.signal,
      })) {
        if (ev.kind === "text") {
          assistant += ev.text;
          bus.emit({ kind: "text_delta", runId: run.id, seq: 0, text: ev.text });
        } else if (ev.kind === "reasoning") {
          bus.emit({ kind: "reasoning_delta", runId: run.id, seq: 0, text: ev.text });
        } else if (ev.kind === "done") {
          run.costUsd += ev.costUsd ?? 0;
        }
      }
      run.messages.push({ role: "assistant", content: assistant });
      if (run.status === "running") run.status = "done";
      bus.emit({ kind: "run.finished", runId: run.id, status: run.status === "cancelled" ? "cancelled" : "done" });
    } catch (e) {
      if (run.controller.signal.aborted) {
        run.status = "cancelled";
        bus.emit({ kind: "run.finished", runId: run.id, status: "cancelled" });
        return;
      }
      throw e;
    }
  }
}
