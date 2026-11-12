import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import { settingsFile } from "@stewart/config";
import { counterIds, fakeHost, systemClock, type ChatMessage, type HostPort } from "@stewart/kernel";
import { Interaction } from "@stewart/interaction";
import { Permissions } from "@stewart/permissions";
import { nativeLoop, type Engine, type EngineEvent, type EngineTurn } from "@stewart/engines";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { RunEvent } from "@stewart/protocol";
import { SessionService, type SessionDeps } from "../src/api.js";

function fakeChannel(turns: ChatEvent[][]): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {
      for (const ev of turns[Math.min(i++, turns.length - 1)]) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

/** Engine that replays a script of steps; each step may inspect the turn before yielding events. */
function scriptedEngine(steps: ((turn: EngineTurn) => AsyncGenerator<EngineEvent, void>)[]): Engine {
  let n = 0;
  return {
    id: "native-loop",
    run(turn: EngineTurn) {
      const step = steps[Math.min(n++, steps.length - 1)];
      return step(turn);
    },
  };
}

function makeConfig(over: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    channels: [{ id: "c", type: "fake", enabled: true, discoverModels: true, extraModels: [], modelCaps: {} }],
    agents: [{ id: "a", channel: "c", model: "m", effort: "medium" }],
    roles: [{ id: "lead", enabled: true, prompt: "You are lead.", skills: ["sk1"], tools: [], writePaths: [], turnBudget: 5 }],
    settings: settingsFile.parse({}),
    skills: [{ id: "sk1", description: "a skill", defaultRoles: [], version: 1, body: "SKILL BODY", source: "shipped", edited: false, updateAvailable: false }],
    errors: [],
    ...over,
  };
}

interface Harness {
  svc: SessionService;
  events: RunEvent[];
  host: HostPort;
  files: Record<string, string>;
  interaction: Interaction;
  config: EffectiveConfig;
  channel: ManagedChannel;
  waitFor(kind: RunEvent["kind"], timeoutMs?: number): Promise<RunEvent>;
}

function harness(over: { config?: EffectiveConfig; channel?: ManagedChannel; engine?: Engine; files?: Record<string, string> } = {}): Harness {
  const { host, files } = fakeHost(over.files ?? {});
  const events: RunEvent[] = [];
  const waiters: { kind: string; res: (e: RunEvent) => void }[] = [];
  const bus = {
    emit(ev: RunEvent) {
      events.push(ev);
      const i = waiters.findIndex((w) => w.kind === ev.kind);
      if (i >= 0) waiters.splice(i, 1)[0].res(ev);
    },
  };
  const ids = counterIds();
  const interaction = new Interaction({ ids, clock: systemClock, bus });
  const config = over.config ?? makeConfig();
  const channel = over.channel ?? fakeChannel([[{ kind: "text", text: "hi" }, { kind: "done" }]]);
  const deps: SessionDeps = {
    host,
    bus,
    ids,
    clock: systemClock,
    interaction,
    permissions: new Permissions(interaction),
    channelFor: () => channel,
    config: () => config,
    engineFor: over.engine ? () => over.engine! : undefined,
  };
  const svc = new SessionService(deps);
  const waitFor = (kind: RunEvent["kind"], timeoutMs = 2000): Promise<RunEvent> => {
    const from = events.length;
    return new Promise((res, rej) => {
      const check = () => events.slice(from).find((e) => e.kind === kind);
      const seen = check();
      if (seen) return res(seen);
      waiters.push({ kind, res: (e) => res(e) });
      setTimeout(() => rej(new Error(`timeout waiting for ${kind}; got ${events.map((e) => e.kind).join(",")}`)), timeoutMs);
    });
  };
  return { svc, events, host, files, interaction, config, channel, waitFor };
}

describe("SessionService", () => {
  it("runs a question turn to done and emits check.result", async () => {
    const h = harness();
    const { runId, sessionId } = await h.svc.send({ text: "what is 2+2?" });
    expect(sessionId).toMatch(/^sess-/);
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ runId, status: "done", roleId: "lead" });
    const check = h.events.find((e) => e.kind === "check.result");
    expect(check).toMatchObject({ passed: true });
  });

  it("fails the run when a write failed", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "tried" });
        yield { kind: "write", record: { path: "a.ts", ok: false, message: "patch failed" } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "edit a.ts" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ runId, status: "failed", error: "write to a.ts failed: patch failed" });
    const check = h.events.find((e) => e.kind === "check.result");
    expect(check).toMatchObject({ passed: false, evidence: ["write to a.ts failed: patch failed"] });
  });

  it("passes file checks when the written file exists", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "wrote a.ts" });
        yield { kind: "write", record: { path: "a.ts", ok: true } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.ts": "new content" } });
    await h.svc.send({ text: "write a.ts" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    const check = h.events.find((e) => e.kind === "check.result");
    expect(check).toMatchObject({ passed: true, evidence: ["changed: a.ts"] });
  });

  it("fails when a changed file is missing afterwards", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "wrote" });
        yield { kind: "write", record: { path: "ghost.ts", ok: true } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "write ghost.ts" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "missing: ghost.ts" });
  });

  it("persists the transcript incl. tool messages and reloads it next turn", async () => {
    const seen: ChatMessage[][] = [];
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        seen.push(turn.transcript.map((m) => ({ ...m })));
        turn.transcript.push({ role: "assistant", content: "reply" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ engine });
    const { sessionId } = await h.svc.send({ text: "first" });
    await h.waitFor("run.finished");
    const stored = h.files[`/tmp/st/history/${sessionId}.json`];
    expect(stored).toBeTruthy();
    await h.svc.send({ sessionId, text: "second" });
    await h.waitFor("run.finished");
    expect(seen[1].map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(seen[1][1]).toMatchObject({ content: "reply" });
  });

  it("survives a transcript containing tool messages on reload", async () => {
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "a", toolCalls: [{ id: "c1", name: "Echo", arguments: {} }] });
        turn.transcript.push({ role: "tool", toolCallId: "c1", content: "tool result" });
        turn.transcript.push({ role: "assistant", content: "final" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ engine });
    const { sessionId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const seen: ChatMessage[][] = [];
    const engine2: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        seen.push([...turn.transcript]);
        turn.transcript.push({ role: "assistant", content: "more" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h2 = harness({ engine: engine2, files: h.files });
    await h2.svc.send({ sessionId, text: "next" });
    await h2.waitFor("run.finished");
    expect(seen[0].map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  });

  it("resolves the agent by fallback order", async () => {
    const captured: string[] = [];
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        captured.push(turn.agent.id);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const agents = [
      { id: "first", channel: "c", model: "m", effort: "medium" as const },
      { id: "orch", channel: "c", model: "m", effort: "medium" as const },
      { id: "bound", channel: "c", model: "m", effort: "medium" as const },
    ];
    const base = makeConfig({ agents });
    // lead unbound → orchestrator's agent
    const c1 = makeConfig({
      agents,
      roles: [base.roles[0], { id: "orchestrator", enabled: false, agent: "orch", skills: [], tools: [], writePaths: [], turnBudget: 5 }],
    });
    let h = harness({ config: c1, engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    // lead bound → its own agent wins
    const c2 = makeConfig({ agents, roles: [{ ...base.roles[0], agent: "bound" }] });
    h = harness({ config: c2, engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    // no bindings at all → first agent
    const c3 = makeConfig({ agents });
    h = harness({ config: c3, engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    expect(captured).toEqual(["orch", "bound", "first"]);
  });

  it("fails clearly when no agent exists", async () => {
    const h = harness({ config: makeConfig({ agents: [] }) });
    await h.svc.send({ text: "x" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: expect.stringContaining("no agent configured") });
  });

  it("runs the native loop end to end including ask_user", async () => {
    const channel = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "q1", name: "ask_user", arguments: { question: "pick one", options: ["a", "b"] } }] }, { kind: "done" }],
      [{ kind: "text", text: "you picked b" }, { kind: "done" }],
    ]);
    const h = harness({ channel, config: makeConfig({ roles: [{ ...makeConfig().roles[0], skills: [] }] }) });
    const { runId } = await h.svc.send({ text: "help me choose" });
    const ask = await h.waitFor("ask_user");
    expect(ask).toMatchObject({ runId, question: "pick one", options: ["a", "b"] });
    const ok = h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "b");
    expect(ok).toBe(true);
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    const toolRow = h.events.find((e) => e.kind === "tool.outcome");
    expect(toolRow).toMatchObject({ ok: true, summary: "b" });
  });

  it("reports load_skill unknown id listing the ids, then continues", async () => {
    const channel = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "s1", name: "load_skill", arguments: { id: "nope" } }] }, { kind: "done" }],
      [{ kind: "text", text: "no such skill" }, { kind: "done" }],
    ]);
    const h = harness({ channel });
    await h.svc.send({ text: "load a skill" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    const outcome = h.events.find((e) => e.kind === "tool.outcome");
    expect(outcome).toMatchObject({ ok: false, summary: "Error: unknown skill 'nope'. Available: sk1" });
  });

  it("ask_user returns not-answered when the question is withdrawn", async () => {
    const channel = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "q1", name: "ask_user", arguments: { question: "pick" } }] }, { kind: "done" }],
      [{ kind: "text", text: "no answer" }, { kind: "done" }],
    ]);
    const h = harness({ channel });
    await h.svc.send({ text: "ask" });
    const ask = await h.waitFor("ask_user");
    expect((ask as { options?: string[] }).options).toBeUndefined();
    h.interaction.withdraw((ask as { questionId: string }).questionId, "cancel");
    await h.waitFor("run.finished");
    const outcome = h.events.find((e) => e.kind === "tool.outcome");
    expect(outcome).toMatchObject({ ok: true, summary: "Not answered: cancelled" });
  });

  it("load_skill returns the body for a known id", async () => {
    const channel = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "s1", name: "load_skill", arguments: { id: "sk1" } }] }, { kind: "done" }],
      [{ kind: "text", text: "got it" }, { kind: "done" }],
    ]);
    const h = harness({ channel });
    await h.svc.send({ text: "load" });
    await h.waitFor("run.finished");
    const outcome = h.events.find((e) => e.kind === "tool.outcome");
    expect(outcome).toMatchObject({ ok: true, summary: "# Skill: sk1" });
  });

  it("aborts the run at the cost cap", async () => {
    const config = makeConfig();
    config.settings.costLimit.perRunUsd = 0.05;
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "usage", inTokens: 10, outTokens: 10, costUsd: 0.1 };
        turn.transcript.push({ role: "assistant", content: "partial" });
        yield { kind: "finished", reason: turn.signal.aborted ? "cancelled" : "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "spend" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "cost cap reached" });
    expect(h.events.some((e) => e.kind === "cost.limit_reached")).toBe(true);
  });

  it("emits cost.summary when the turn accrued cost", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "usage", inTokens: 5, outTokens: 5, costUsd: 0.01 };
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    const summary = h.events.find((e) => e.kind === "cost.summary");
    expect(summary).toMatchObject({ accruedUsd: 0.01, byRole: { lead: 0.01 } });
  });

  it("cancels a running turn", async () => {
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        while (!turn.signal.aborted) await new Promise((r) => setTimeout(r, 5));
        yield { kind: "finished", reason: "cancelled" };
      },
    };
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "long" });
    await h.waitFor("run.started");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.svc.cancel(runId)).toBe(true);
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "cancelled" });
    expect(h.svc.cancel("run-unknown")).toBe(false);
  });

  it("fails clearly when the lead role is missing or disabled", async () => {
    let h = harness({ config: makeConfig({ roles: [] }) });
    await h.svc.send({ text: "x" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "failed", error: "role 'lead' not configured" });
    const disabled = makeConfig({ roles: [{ ...makeConfig().roles[0], enabled: false }] });
    h = harness({ config: disabled });
    await h.svc.send({ text: "x" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "failed", error: "role 'lead' is disabled" });
  });

  it("indexes skills by body first line when description is empty, and caps turnBudget at 200 for unlimited", async () => {
    const captured: { system?: string; maxTurns?: number } = {};
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        captured.system = turn.system;
        captured.maxTurns = turn.maxTurns;
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const config = makeConfig({
      roles: [{ ...makeConfig().roles[0], turnBudget: "unlimited" }],
      skills: [{ id: "sk1", description: "", defaultRoles: [], version: 1, body: "BODY FIRST LINE\nrest", source: "shipped", edited: false, updateAvailable: false }],
    });
    const h = harness({ config, engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    expect(captured.maxTurns).toBe(200);
    expect(captured.system).toContain("- sk1: BODY FIRST LINE");
    expect(captured.system).toContain("You are lead.");
  });

  it("persists engine state between turns", async () => {
    const engine: Engine = {
      id: "native-loop",
      async *run(turn: EngineTurn) {
        turn.state.count = (Number(turn.state.count) || 0) + 1;
        turn.transcript.push({ role: "assistant", content: `n=${turn.state.count}` });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ engine });
    const { sessionId } = await h.svc.send({ text: "one" });
    await h.waitFor("run.finished");
    expect(JSON.parse(h.files[`/tmp/st/sessions/${sessionId}.engine.json`])).toEqual({ count: 1 });
  });
});

describe("send", () => {
  it("reuses the caller's sessionId", async () => {
    const h = harness();
    const r = await h.svc.send({ sessionId: "s-fixed", text: "x" });
    expect(r.sessionId).toBe("s-fixed");
    await h.waitFor("run.finished");
  });
});
