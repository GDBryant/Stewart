import { beforeEach, describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter } from "@stewart/channels";
import type { EngineEvent, EngineTurn } from "@stewart/engines";
import type { RunEvent } from "@stewart/protocol";
import { cliPolicyGate, policyFailed, resetPolicyAnswers } from "../src/policyGate.js";
import { harness, makeConfig, scriptedEngine } from "./harness.js";

const adapter = (type: string): ChannelAdapter => ({ type, listModels: async () => [], probeCaps: async () => ({}), chat: async function* () {} });
const channel = (id: string, type: string, rules: boolean): ManagedChannel => {
  const ch = new ManagedChannel(adapter(type), { id, type, enabled: true, maxParallel: 4 });
  if (rules) ch.setRules(["passwords"]);
  return ch;
};
const done = async function* (turn: EngineTurn) {
  turn.transcript.push({ role: "assistant", content: `done by ${turn.agent.id}` });
  yield { kind: "finished" as const, reason: "stop" as const };
};
const answerNext = async (h: ReturnType<typeof harness>, value: string) => h.interaction.resolveAnswer(((await h.waitFor("ask_user")) as { questionId: string }).questionId, value);
const notices = (events: RunEvent[]) => events.filter((e) => e.kind === "policy.notice");

beforeEach(() => resetPolicyAnswers());

describe("policy.notice event", () => {
  it("is forwarded from the engine with run and role", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "policy.notice", channel: "c", rule: "passwords", action: "withheld", where: "tool", msgIndex: 2 } as EngineEvent;
        yield* done(turn);
      },
    ]);
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(notices(h.events)).toEqual([{ kind: "policy.notice", runId, roleId: "lead", channel: "c", rule: "passwords", action: "withheld", where: "tool", msgIndex: 2 }]);
  });
});

describe("escalation after a business-policy failure", () => {
  const agents = [
    { id: "a1", channel: "c1", model: "m", effort: "medium" as const },
    { id: "a2", channel: "c1", model: "m", effort: "medium" as const },
    { id: "a3", channel: "c2", model: "m", effort: "medium" as const },
  ];
  const lead = { ...makeConfig().roles[0], agent: "a1", secondary: "a2" };
  const fail = async function* () {
    yield { kind: "finished" as const, reason: "error" as const, error: "business_policy: blocked outgoing message to c1: passwords in user #1 (secret assignment)" };
  };
  const cfg = (secondary: string) => {
    const base = makeConfig();
    const qual = base.channels[0].modelCaps;
    return makeConfig({ agents, roles: [{ ...lead, secondary }], channels: ["c1", "c2"].map((id) => ({ ...base.channels[0], id, modelCaps: qual })) });
  };
  const channels = { c1: channel("c1", "fake", true), c2: channel("c2", "fake", false) };

  it("does not retry on the same channel and fails with the evidence", async () => {
    const seen: string[] = [];
    const engine = scriptedEngine([async function* (t: EngineTurn) { seen.push(t.agent.id); yield* fail(); }, done]);
    const h = harness({ config: cfg("a2"), engine, channelFor: (id) => channels[id as "c1"] });
    await h.svc.send({ text: "go" });
    await answerNext(h, "Stop");
    const fin = (await h.waitFor("run.finished")) as { status: string; error?: string };
    expect(seen).toEqual(["a1"]);
    expect(fin.status).toBe("failed");
    expect(h.events.filter((e) => e.kind === "run.escalated")).toHaveLength(0);
    expect(fin.error).toMatch(/^business_policy:|business_policy: blocked/);
  });

  it("escalates to an agent on a different channel", async () => {
    const seen: string[] = [];
    const engine = scriptedEngine([async function* (t: EngineTurn) { seen.push(t.agent.id); yield* fail(); }, async function* (t: EngineTurn) { seen.push(t.agent.id); yield* done(t); }]);
    const h = harness({ config: cfg("a3"), engine, channelFor: (id) => channels[id as "c1"] });
    await h.svc.send({ text: "go" });
    const fin = await h.waitFor("run.finished");
    expect(seen).toEqual(["a1", "a3"]);
    expect(fin).toMatchObject({ status: "done" });
  });

  it("policyFailed recognises the prefix only", () => {
    expect(policyFailed("business_policy: refused")).toBe(true);
    expect(policyFailed("boom")).toBe(false);
    expect(policyFailed(undefined)).toBe(false);
  });
});

describe("claude-cli ask", () => {
  const cli = () => channel("cli", "claude-cli", true);
  const cliConfig = () => {
    const base = makeConfig();
    return makeConfig({ channels: [{ ...base.channels[0], id: "cli", type: "claude-cli" }], agents: [{ id: "a", channel: "cli", model: "m", effort: "medium" }] });
  };

  it("asks Continue/Stop, runs on Continue and remembers it for the session", async () => {
    let runs = 0;
    const engine = scriptedEngine([async function* (t: EngineTurn) { runs++; yield* done(t); }]);
    const h = harness({ config: cliConfig(), channel: cli(), engine });
    const { sessionId } = await h.svc.send({ text: "one" });
    const ask = (await h.waitFor("ask_user")) as { questionId: string; question: string; options: string[] };
    expect(ask.options).toEqual(["Continue", "Stop"]);
    expect(ask.question).toContain("cli");
    h.interaction.resolveAnswer(ask.questionId, "Continue");
    await h.waitFor("run.finished");
    expect(runs).toBe(1);
    const before = h.events.filter((e) => e.kind === "ask_user").length;
    await h.svc.send({ text: "two", sessionId });
    await h.waitFor("run.finished");
    expect(h.events.filter((e) => e.kind === "ask_user")).toHaveLength(before);
    expect(runs).toBe(2);
  });

  it("Stop fails the run with a refusal notice and never starts the engine", async () => {
    let runs = 0;
    const engine = scriptedEngine([async function* (t: EngineTurn) { runs++; yield* done(t); }]);
    const h = harness({ config: cliConfig(), channel: cli(), engine });
    const { runId } = await h.svc.send({ text: "one" });
    await answerNext(h, "Stop");
    await answerNext(h, "Stop"); // then the lead's own "all agents failed" question
    const fin = (await h.waitFor("run.finished")) as { status: string; error?: string };
    expect(runs).toBe(0);
    expect(fin.status).toBe("failed");
    expect(fin.error).toContain("business_policy: refused");
    expect(notices(h.events)).toMatchObject([{ runId, channel: "cli", rule: "passwords", action: "refused" }]);
  });

  it("does not ask when no rule is ticked or the channel is not claude-cli", async () => {
    const engine = scriptedEngine([done]);
    const h = harness({ config: cliConfig(), channel: channel("cli", "claude-cli", false), engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(h.events.some((e) => e.kind === "ask_user")).toBe(false);
    const h2 = harness({ engine: scriptedEngine([done]), channel: channel("c", "fake", true) });
    await h2.svc.send({ text: "go" });
    await h2.waitFor("run.finished");
    expect(h2.events.some((e) => e.kind === "ask_user")).toBe(false);
  });
});

describe("cliPolicyGate for children", () => {
  const events: RunEvent[] = [];
  const ctx = (sessionId: string, interactive: boolean) => ({
    spec: { runId: "r", sessionId, role: { id: "x" }, interactive, run: { controller: new AbortController() } },
    deps: { bus: { emit: (e: RunEvent) => void events.push(e) } },
  });

  it("a child without a lead answer is refused and notified", async () => {
    events.length = 0;
    const out = await cliPolicyGate(ctx("s1/task1", false), channel("cli", "claude-cli", true));
    expect(out).toMatch(/^business_policy: refused/);
    expect(events).toHaveLength(1);
  });

  it("a child inherits the lead's Continue", async () => {
    const asks: string[] = [];
    const interaction = { ask: async (p: { question: string }) => (asks.push(p.question), { kind: "answered", value: "Continue" }) };
    const lead = { ...ctx("s1", true), deps: { bus: { emit: () => {} }, interaction: interaction as never } };
    const ch = channel("cli", "claude-cli", true);
    expect(await cliPolicyGate(lead, ch)).toBeUndefined();
    expect(await cliPolicyGate(ctx("s1/task9", false), ch)).toBeUndefined();
    expect(await cliPolicyGate(ctx("other/task1", false), ch)).toMatch(/refused/);
    expect(asks).toHaveLength(1);
  });

  it("a withdrawn question counts as Stop", async () => {
    const interaction = { ask: async () => ({ kind: "withdrawn", reason: "timeout" }) };
    const lead = { ...ctx("s2", true), deps: { bus: { emit: () => {} }, interaction: interaction as never } };
    expect(await cliPolicyGate(lead, channel("cli", "claude-cli", true))).toMatch(/refused/);
  });
});
