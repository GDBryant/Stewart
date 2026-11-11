import { describe, expect, it, vi } from "vitest";
import { EventBus, counterIds, fakeHost, systemClock, type Clock } from "@stewart/kernel";
import { loadEffectiveConfig, type EffectiveConfig } from "@stewart/roles-skills";
import type { RunRuntime } from "@stewart/run-contract";
import { RunService } from "../src/api.js";
import { runPipeline, type PlanCtx, type Refusal, type RunOutcome, type RunPlan, type RunStrategy } from "../src/strategy.js";
import type { Run } from "../src/types.js";

function svc(clock: Clock = systemClock) {
  const events: { kind: string; [k: string]: unknown }[] = [];
  const { host, files } = fakeHost();
  const s = new RunService({ host, clock, ids: counterIds(), bus: new EventBus((e) => events.push(e as never), 0) });
  return { s, host, files, events };
}

interface Req {
  config: EffectiveConfig;
  title?: string;
  profileName?: string;
  sessionId?: string;
  outcome?: RunOutcome;
  throw?: unknown;
  setCancelled?: boolean;
}

const emptyConfig = () => loadEffectiveConfig({}, {}, {}, { trusted: true });

function strategy(over: Partial<RunStrategy<Req>> = {}): RunStrategy<Req> {
  return {
    plan: async (s, projectId, req): Promise<RunPlan | Refusal> => {
      const run: Run = { id: s.deps.ids.next("run"), projectId, status: "running", controller: new AbortController(), startedAt: s.deps.clock.now(), messages: [{ role: "user", content: "hi" }], costUsd: 0, sessionId: req.sessionId };
      return { run, title: req.title ?? "hi", config: req.config, profileName: req.profileName, channelFor: () => { throw new Error("no channel"); } };
    },
    execute: async ({ run, req }): Promise<RunOutcome> => {
      if (req.setCancelled) run.status = "cancelled";
      if (req.throw) throw req.throw;
      return req.outcome ?? { status: "done", event: "done" };
    },
    ...over,
  };
}

async function finished(events: { kind: string }[]): Promise<{ [k: string]: unknown }> {
  return vi.waitFor(() => {
    const ev = events.find((e) => e.kind === "run.finished");
    if (!ev) throw new Error("not finished");
    return ev;
  });
}

describe("runPipeline", () => {
  it("refusal: nothing registered or emitted, reason passed through", async () => {
    const { s, events } = svc();
    const st = strategy({ plan: async () => ({ ok: false, reason: "nope" }) });
    const r = await runPipeline(s, st, "p", { config: emptyConfig() });
    expect(r).toEqual({ ok: false, reason: "nope" });
    expect(s.get("run-1")).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("happy path: run.started then run.finished, status/cost set, journal + history written", async () => {
    const { s, files, events } = svc();
    const saveHistory = vi.spyOn(s, "saveHistory");
    const r = await runPipeline(s, strategy(), "p", { config: emptyConfig(), title: "x".repeat(100), sessionId: "sess1" });
    expect(r.ok).toBe(true);
    const run = (r as { run: Run }).run;
    const started = events.find((e) => e.kind === "run.started")!;
    expect(started).toMatchObject({ runId: run.id, title: "x".repeat(80) });
    expect(started.profile).toBeUndefined();
    const fin = await finished(events);
    expect(fin).toMatchObject({ runId: run.id, status: "done" });
    expect(run.status).toBe("done");
    expect(run.costUsd).toBe(0);
    expect(files[`/tmp/st/scratch/${run.id}/run.json`]).toBeDefined();
    expect(saveHistory).toHaveBeenCalled();
  });

  it("run.started carries profile only when the plan names one", async () => {
    const { s, events } = svc();
    await runPipeline(s, strategy(), "p", { config: emptyConfig(), profileName: "deep" });
    const started = events.find((e) => e.kind === "run.started")!;
    expect(started.profile).toBe("deep");
    await finished(events);
  });

  it("execute throws → run.finished failed with the message, journal written", async () => {
    const { s, files, events } = svc();
    const r = await runPipeline(s, strategy(), "p", { config: emptyConfig(), throw: new Error("boom") });
    const run = (r as { run: Run }).run;
    const fin = await finished(events);
    expect(fin).toMatchObject({ status: "failed", error: "boom" });
    expect(run.status).toBe("failed");
    expect(files[`/tmp/st/scratch/${run.id}/run.json`]).toBeDefined();
  });

  it("execute cancels before throwing → status stays cancelled", async () => {
    const { s, events } = svc();
    const r = await runPipeline(s, strategy(), "p", { config: emptyConfig(), setCancelled: true, throw: new Error("x") });
    const run = (r as { run: Run }).run;
    await finished(events);
    expect(run.status).toBe("cancelled");
  });

  it("arms and cancels the time-cap timer", async () => {
    let cancelled = 0;
    let armed = false;
    const clock: Clock = {
      ...systemClock,
      setTimeout: (fn: () => void, ms: number) => {
        armed = true;
        void fn;
        void ms;
        return { cancel: () => cancelled++ };
      },
    };
    const { s, events } = svc(clock);
    const config = loadEffectiveConfig({ "settings.yaml": "version: 1\nmaxRunHours: 1" }, {}, {}, { trusted: true });
    await runPipeline(s, strategy(), "p", { config });
    await finished(events);
    expect(armed).toBe(true);
    expect(cancelled).toBe(1);
  });
});
