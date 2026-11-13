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
import { fakeChannel, harness, makeConfig, scriptedEngine, type Harness } from "./harness.js";

/** A successful read call: a read-only child's report must have looked at something. */
async function* readOnce(id = "r"): AsyncGenerator<EngineEvent, void> {
  yield { kind: "tool.request", callId: `read-${id}`, tool: "ReadFile", args: { path: "x" }, category: "OTHER" };
  yield { kind: "tool.outcome", callId: `read-${id}`, ok: true, summary: "x" };
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
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ runId, status: "failed" });
    expect((fin as { error: string }).error).toContain("write to a.ts failed: patch failed");
    const check = h.events.find((e) => e.kind === "check.result");
    expect(check).toMatchObject({ passed: false });
    expect((check as { evidence: string[] }).evidence).toContain("write to a.ts failed: patch failed");
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
    expect(check).toMatchObject({ passed: true, evidence: [] });
  });

  it("fails when a declared file is missing afterwards", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        await turn.tools.find("set_check")!.execute({ command: ["true"], files: ["ghost.ts"] }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "wrote" });
        yield { kind: "write", record: { path: "ghost.ts", ok: true } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "write ghost.ts" });
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "missing: ghost.ts" });
  });

  it("forgives a failed write record when the tracker still sees the change", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "1", tool: "EditFile", args: { path: "a.ts" }, category: "FILE" };
        h.files["a.ts"] = "changed by a later shell edit";
        turn.transcript.push({ role: "assistant", content: "edited" });
        yield { kind: "write", record: { path: "a.ts", ok: false, message: "patch failed" } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.ts": "old" } });
    await h.svc.send({ text: "edit a.ts" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("passes an edit turn whose file content changed", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "1", tool: "EditFile", args: { path: "a.ts" }, category: "FILE" };
        h.files["a.ts"] = "different";
        turn.transcript.push({ role: "assistant", content: "edited" });
        yield { kind: "write", record: { path: "a.ts", ok: true } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.ts": "old" } });
    await h.svc.send({ text: "edit a.ts" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("does not citation-check the lead's reply", async () => {
    const h = harness({
      engine: scriptedEngine([
        async function* (turn: EngineTurn) {
          turn.transcript.push({ role: "assistant", content: "Looks fine overall, though made/up.ts:9 could be simpler." });
          yield { kind: "finished", reason: "stop" };
        },
      ]),
    });
    await h.svc.send({ text: "review src" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("set_check declares a command that must exit 0", async () => {
    const mk = (code: number) => {
      const engine = scriptedEngine([
        async function* (turn: EngineTurn) {
          await turn.tools.find("set_check")!.execute({ command: ["npm", "test"] }, null, turn.signal);
          turn.transcript.push({ role: "assistant", content: "done" });
          yield { kind: "finished", reason: "stop" };
        },
      ]);
      const h = harness({ engine });
      (h.host as unknown as { proc: { run: unknown } }).proc.run = () => ({ done: Promise.resolve({ code }), killTree: async () => {} });
      return h;
    };
    const ok = mk(0);
    await ok.svc.send({ text: "run tests" });
    expect(await ok.waitFor("run.finished")).toMatchObject({ status: "done" });
    const bad = mk(1);
    await bad.svc.send({ text: "run tests" });
    const ask = await bad.waitFor("ask_user");
    bad.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = (await bad.waitFor("run.finished")) as { status: string; error: string };
    expect(fin.status).toBe("failed");
    expect(fin.error).toContain("npm test exited 1");
  });

  it("persists the transcript incl. tool messages and reloads it next turn", async () => {
    const seen: ChatMessage[][] = [];
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
    // lead bound → its own agent wins
    const c2 = makeConfig({ agents, roles: [{ ...makeConfig({ agents }).roles[0], agent: "bound" }] });
    let h = harness({ config: c2, engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    // lead unbound → first agent
    h = harness({ config: makeConfig({ agents }), engine });
    await h.svc.send({ text: "x" });
    await h.waitFor("run.finished");
    expect(captured).toEqual(["bound", "first"]);
  });

  it("fails clearly when no agent exists", async () => {
    const h = harness({ config: makeConfig({ agents: [] }) });
    await h.svc.send({ text: "x" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: expect.stringContaining("no qualified agent for role lead") });
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
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

describe("SessionService delegate", () => {
  const reviewer = { id: "reviewer", enabled: true, prompt: "You review.", skills: ["code-health"], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };
  const explorer = { id: "explorer", enabled: true, prompt: "You explore.", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };

  function delegateCall(task: string, role = "reviewer", report?: string) {
    return { id: `d-${Math.random()}`, name: "delegate", arguments: { role, task, ...(report ? { report } : {}) } };
  }

  it("runs a child turn to task.done and returns status done to the lead", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    const engine = scriptedEngine([
      async function* (turn) {
        yield { kind: "tool.request", callId: "1", tool: "delegate", args: {}, category: "OTHER" };
        const tool = turn.tools.find("delegate")!;
        const out = String(await tool.execute({ role: "reviewer", task: "review src/a.ts" }, null, turn.signal));
        expect(out).toContain("status: done");
        expect(out).toContain("src/a.ts:1");
        turn.transcript.push({ role: "tool", toolCallId: "1", content: out });
        turn.transcript.push({ role: "assistant", content: "all done: src/a.ts:1 fine" });
        yield { kind: "tool.outcome", callId: "1", ok: true, summary: "done" };
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        yield* readOnce();
        yield { kind: "text", text: "src/a.ts:1 — fine" };
        turn.transcript.push({ role: "assistant", content: "src/a.ts:1 — fine" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine, files: { "src/a.ts": "x" } });
    await h.svc.send({ text: "review it" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    const created = h.events.find((e) => e.kind === "task.created");
    expect(created).toMatchObject({ roleId: "reviewer", title: "review src/a.ts" });
    expect(h.events.some((e) => e.kind === "task.started")).toBe(true);
    const done = h.events.find((e) => e.kind === "task.done");
    expect(done).toMatchObject({ roleId: "reviewer" });
    const childFile = Object.keys(h.files).find((k) => k.includes("/sessions/") && k.includes("/task-"));
    expect(childFile).toBeTruthy();
    expect(JSON.parse(h.files[childFile!])[0]).toMatchObject({ role: "user", content: "review src/a.ts" });
  });

  it("rejects unknown, disabled and lead roles and malformed checks as tool errors", async () => {
    const worker = { id: "general-worker", enabled: true, prompt: "", skills: [], tools: [], writePaths: [], turnBudget: 5 };
    const seeker = { id: "seeker", enabled: true, prompt: "", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };
    const config = makeConfig({ roles: [makeConfig().roles[0], { ...explorer, enabled: false }, worker, seeker] });
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        await expect(tool.execute({ role: "ghost", task: "x" }, null, turn.signal)).rejects.toThrow(/unknown delegate role/);
        await expect(tool.execute({ role: "explorer", task: "x" }, null, turn.signal)).rejects.toThrow(/unknown delegate role/);
        await expect(tool.execute({ role: "seeker", task: "x", report: "health" }, null, turn.signal)).rejects.toThrow(/cannot report health.*no configured role/s);
        await expect(tool.execute({ role: "lead", task: "x" }, null, turn.signal)).rejects.toThrow(/unknown delegate role/);
        expect((tool.spec.parameters as { properties: { role: { enum: string[] } } }).properties.role.enum).toEqual(["general-worker", "seeker"]);
        await expect(tool.execute({ role: "seeker", task: "x", check: "nope" }, null, turn.signal)).rejects.toThrow(/check must be an object/);
        turn.transcript.push({ role: "assistant", content: "checked" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished"))).toMatchObject({ status: "done" });
  });

  it("serializes write-capable children and runs read-only ones in parallel", async () => {
    const writer = { id: "wr", enabled: true, prompt: "", skills: [], tools: ["WriteFile"], writePaths: [], turnBudget: 5 };
    const config = makeConfig({ roles: [makeConfig().roles[0], writer, reviewer] });
    const active = { wr: 0, reviewer: 0 };
    const peak = { wr: 0, reviewer: 0 };
    let n = 0;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
      async *run(turn: EngineTurn) {
        if (n++ === 0) {
          const t = turn.tools.find("delegate")!;
          await Promise.all([
            t.execute({ role: "wr", task: "a" }, null, turn.signal),
            t.execute({ role: "wr", task: "b" }, null, turn.signal),
            t.execute({ role: "reviewer", task: "c" }, null, turn.signal),
            t.execute({ role: "reviewer", task: "d" }, null, turn.signal),
          ]);
          turn.transcript.push({ role: "assistant", content: "ok" });
          yield { kind: "finished", reason: "stop" };
          return;
        }
        const id = turn.system.includes("You review.") ? "reviewer" : "wr";
        active[id]++;
        peak[id] = Math.max(peak[id], active[id]);
        await new Promise((r) => setTimeout(r, 20));
        active[id]--;
        yield* readOnce(id);
        turn.transcript.push({ role: "assistant", content: "src/a.ts:1 ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ config, engine, files: { "src/a.ts": "x" } });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(peak.wr).toBe(1);
    expect(peak.reviewer).toBe(2);
  });

  it("delegate check: files must exist and the command must pass the gate and exit 0", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    const out: string[] = [];
    let n = 0;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
      async *run(turn: EngineTurn) {
        if (n++ === 0) {
          const t = turn.tools.find("delegate")!;
          out.push(String(await t.execute({ role: "reviewer", task: "t", check: { files: ["missing.md"] } }, null, turn.signal)));
          turn.transcript.push({ role: "assistant", content: "ok: no findings" });
          yield { kind: "finished", reason: "stop" };
          return;
        }
        turn.transcript.push({ role: "assistant", content: "src/a.ts:1 ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ config, engine, files: { "src/a.ts": "x" } });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(out[0]).toContain("status: failed");
    expect(out[0]).toContain("missing: missing.md");
  });

  it("runs a kind:function role as one schema-checked request, no tools", async () => {
    const fn = { id: "scorer", enabled: true, prompt: "Score it.", skills: [], tools: [], writePaths: [], turnBudget: 1, kind: "function" as const };
    const config = makeConfig({ roles: [makeConfig().roles[0], fn] });
    const config2 = { ...config, channels: [{ ...config.channels[0], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 }, function: { passed: true, at: 1, version: 2, context: 32000 } } } } }] };
    const out: string[] = [];
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const engine = scriptedEngine([
      async function* (turn) {
        const t = turn.tools.find("delegate")!;
        await expect(t.execute({ role: "scorer", task: "x" }, null, turn.signal)).rejects.toThrow(/need a schema/);
        out.push(String(await t.execute({ role: "scorer", task: "x", schema }, null, turn.signal)));
        turn.transcript.push({ role: "assistant", content: "ok: no findings" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const good = harness({ config: config2, engine, channel: fakeChannel([[{ kind: "text", text: '{"n": 7}' }, { kind: "done" }]]) });
    await good.svc.send({ text: "go" });
    await good.waitFor("run.finished");
    expect(out[0]).toBe('status: done\n{"n":7}');
    expect(good.events.find((e) => e.kind === "task.done")).toMatchObject({ roleId: "scorer" });
    out.length = 0;
    const bad = harness({ config: config2, engine, channel: fakeChannel([[{ kind: "text", text: "nope" }, { kind: "done" }]]) });
    await bad.svc.send({ text: "go" });
    await bad.waitFor("run.finished");
    expect(out[0]).toContain("status: failed");
    expect(bad.events.find((e) => e.kind === "task.failed")).toMatchObject({ roleId: "scorer" });
  });

  it("returns status failed with check evidence when the child check fails", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    let result = "";
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        result = String(await tool.execute({ role: "reviewer", task: "review nothing" }, null, turn.signal));
        turn.transcript.push({ role: "assistant", content: "ok: no findings" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        turn.transcript.push({ role: "assistant", content: "Everything looks great." });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "look into it" });
    await h.waitFor("run.finished");
    expect(h.events.find((e) => e.kind === "task.failed")).toMatchObject({ roleId: "reviewer" });
    expect(result).toContain("status: failed");
    expect(result).toContain("check:");
  });

  it("child registry has no delegate or write tools for a read-only role", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        await tool.execute({ role: "reviewer", task: "look" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        const names = turn.tools.specs.map((s) => s.name);
        expect(names).toContain("ReadFile");
        expect(names).not.toContain("delegate");
        expect(names).not.toContain("WriteFile");
        expect(names).not.toContain("health_report");
        turn.transcript.push({ role: "assistant", content: "found nothing" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished"))).toMatchObject({ status: "done" });
  });

  it("denies file edits and mutating commands to read-only child roles", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], { ...reviewer, tools: ["ReadFile", "RunTerminal"] }] });
    let h: Harness;
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        await tool.execute({ role: "reviewer", task: "check" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        const file = await turn.approve({ id: "1", name: "Edit", arguments: {} }, { kind: "file", path: "a.ts", before: null, after: "x" }, {});
        expect(file.kind).toBe("rejected");
        const cmd = await turn.approve({ id: "2", name: "Bash", arguments: {} }, { kind: "command", command: "rm -rf x" }, {});
        expect(cmd.kind).toBe("rejected");
        const reqP = h.waitFor("approval.request");
        const ro = turn.approve({ id: "3", name: "Bash", arguments: {} }, { kind: "command", command: "git status" }, {});
        const req = await reqP;
        h.interaction.resolveApproval((req as { approvalId: string }).approvalId, "once");
        expect((await ro).kind).toBe("approved");
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "found nothing" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished"))).toMatchObject({ status: "done" });
  });

  it("applies the role profile to claude-code children: no RunTerminal, writePaths", async () => {
    const tester = { id: "tester", enabled: true, prompt: "t", skills: [], tools: ["ReadFile", "WriteFile"], writePaths: ["**/*.test.ts"], turnBudget: 5 };
    const config = makeConfig({ roles: [makeConfig().roles[0], tester] });
    const decisions: string[] = [];
    let h: Harness;
    const engine = scriptedEngine([
      async function* (turn) {
        await turn.tools.find("delegate")!.execute({ role: "tester", task: "add a test" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        const src = await turn.approve({ id: "1", name: "Edit", arguments: {} }, { kind: "file", path: "src/a.ts", before: null, after: "x" }, {});
        decisions.push(src.kind === "rejected" ? src.reason : src.kind);
        const cmd = await turn.approve({ id: "2", name: "Bash", arguments: {} }, { kind: "command", command: "ls" }, {});
        decisions.push(cmd.kind === "rejected" ? cmd.reason : cmd.kind);
        const reqP = h.waitFor("approval.request");
        const ok = turn.approve({ id: "3", name: "Edit", arguments: {} }, { kind: "file", path: "src/a.test.ts", before: null, after: "x" }, {});
        h.interaction.resolveApproval(((await reqP) as { approvalId: string }).approvalId, "once");
        decisions.push((await ok).kind);
        turn.transcript.push({ role: "assistant", content: "added" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(decisions[0]).toContain("outside this role's writePaths");
    expect(decisions[1]).toContain("has no RunTerminal");
    expect(decisions[2]).toBe("approved");
  });

  it("caps concurrent children at 4 and runs them in parallel", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], explorer] });
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    let step = 0;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "no complete" }),
      async *run(turn) {
        if (step++ === 0) {
          const tool = turn.tools.find("delegate")!;
          const results = await Promise.all(
            [1, 2, 3, 4, 5, 6].map((n) => tool.execute({ role: "explorer", task: `t${n}` }, null, turn.signal)),
          );
          expect(results.every((r) => String(r).startsWith("status: done"))).toBe(true);
          turn.transcript.push({ role: "assistant", content: "ok" });
          yield { kind: "finished", reason: "stop" };
          return;
        }
        active++;
        started.push(active);
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        yield* readOnce(turn.sessionId);
        turn.transcript.push({ role: "assistant", content: "nothing found" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished"))).toMatchObject({ status: "done" });
    expect(maxActive).toBe(4);
    expect(h.events.filter((e) => e.kind === "task.done")).toHaveLength(6);
  });

  it("meters child usage under the child role and counts it toward the cap", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    config.settings = settingsFile.parse({ costLimit: { perRunUsd: 0.000001 } });
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        await tool.execute({ role: "reviewer", task: "x" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "cancelled" };
      },
      async function* (turn) {
        turn.transcript.push({ role: "assistant", content: "nothing found" });
        yield { kind: "usage", inTokens: 10, outTokens: 10, costUsd: 5 };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "cost cap reached" });
    expect(h.events.some((e) => e.kind === "cost.limit_reached")).toBe(true);
  });

  it("health_report merges reports, writes the file, and fails with no reports", async () => {
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer] });
    const report = { files: [{ path: "src/a.ts", loc: 5, score: 8, band: "Yellow" }], findings: [{ path: "src/a.ts", line: 2, smell: "nesting", severity: "med", refactor: "extract" }], notChecked: [] };
    let merged = "";
    const engine = scriptedEngine([
      async function* (turn) {
        const tool = turn.tools.find("delegate")!;
        const hr = turn.tools.find("health_report")!;
        await expect(hr.execute({}, null, turn.signal)).rejects.toThrow(/no health reports/);
        const out = String(await tool.execute({ role: "reviewer", task: "health src/a.ts", report: "health" }, null, turn.signal));
        expect(out).toContain("status: done");
        merged = String(await hr.execute({}, null, turn.signal));
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn) {
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: `Reviewed.\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine, files: { "src/a.ts": "const a = 1;\n" } });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished"))).toMatchObject({ status: "done" });
    expect(merged).toContain("Report: .stewart/reports/health-");
    const reportFile = Object.keys(h.files).find((k) => k.includes(".stewart/reports/health-"));
    expect(reportFile).toBeTruthy();
    expect(h.files[reportFile!]).toContain("src/a.ts");
  });
});

describe("lead escalation over the chain", () => {
  const twoAgents = [
    { id: "a1", channel: "c", model: "m", effort: "medium" as const },
    { id: "a2", channel: "c", model: "m", effort: "medium" as const },
  ];
  const leadChain = { ...makeConfig().roles[0], chain: ["a1", "a2"] };
  const cfg = () => makeConfig({ agents: twoAgents, roles: [leadChain] });
  const ok = async function* (turn: EngineTurn) {
    turn.transcript.push({ role: "assistant", content: `done by ${turn.agent.id}` });
    yield { kind: "finished" as const, reason: "stop" as const };
  };

  it("escalates on turn_limit, emits run.escalated and appends the handover", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "t1", tool: "ReadFile", args: { path: "a.ts" }, category: "other" as const };
        yield { kind: "tool.outcome", callId: "t1", ok: false, summary: "denied" };
        yield { kind: "finished", reason: "turn_limit" };
      },
      ok,
    ]);
    const h = harness({ config: cfg(), engine });
    await h.svc.send({ text: "look at it" });
    const esc = await h.waitFor("run.escalated");
    expect(esc).toMatchObject({ roleId: "lead", from: "a1", to: "a2", reason: "turn_limit" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    const handover = h.config && (h as unknown as { svc: SessionService });
    void handover;
  });

  it("escalates on loop_guard and on engine error, not on cancel", async () => {
    for (const reason of ["loop_guard", "error"] as const) {
      const engine = scriptedEngine([async function* () { yield { kind: "finished" as const, reason, error: "boom" }; }, ok]);
      const h = harness({ config: cfg(), engine });
      await h.svc.send({ text: "go" });
      const esc = await h.waitFor("run.escalated");
      expect(esc).toMatchObject({ from: "a1", to: "a2", reason });
      await h.waitFor("run.finished");
    }
  });

  it("escalates when the check fails and the handover reaches the next agent", async () => {
    const seen: string[] = [];
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "wrote" });
        yield { kind: "write", record: { path: "ghost.ts", ok: false, message: "patch failed" } };
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        seen.push(JSON.stringify(turn.transcript));
        const wf = turn.tools.find("WriteFile")!;
        const args = { path: "ghost.ts", content: "x" };
        await wf.execute(args, (await wf.preview?.(args)) ?? null, turn.signal);
        yield* ok(turn);
      },
    ]);
    const h = harness({ config: cfg(), engine, files: {} });
    await h.svc.send({ text: "write ghost.ts" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.find((e) => e.kind === "run.escalated")).toMatchObject({ from: "a1", to: "a2", reason: "check_failed" });
    expect(seen[0]).toContain("Handover: the previous agent (a1) did not finish this task.");
    expect(seen[0]).toContain("Goal: write ghost.ts");
    expect(seen[0]).toContain("write to ghost.ts failed: patch failed");
    expect(seen[0]).toContain("Continue from the current state of the files.");
  });

  it("does not escalate on cancel", async () => {
    const engine = scriptedEngine([
      async function* () { yield { kind: "finished", reason: "cancelled" }; },
      ok,
    ]);
    const h = harness({ config: cfg(), engine });
    await h.svc.send({ text: "go" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "cancelled" });
    expect(h.events.some((e) => e.kind === "run.escalated")).toBe(false);
  });

  it("asks the user after the last agent and retries once with guidance", async () => {
    const fail = async function* () { yield { kind: "finished" as const, reason: "turn_limit" as const }; };
    const engine = scriptedEngine([fail, fail, ok]);
    const h = harness({ config: cfg(), engine });
    await h.svc.send({ text: "hard task" });
    const ask = await h.waitFor("ask_user");
    expect(ask).toMatchObject({ options: ["Stop"] });
    expect((ask as { question: string }).question).toContain("All agents for this task failed.");
    expect((ask as { question: string }).question).toContain("a2");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "try reading the file first");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
  });

  it("fails with the evidence when the user answers Stop", async () => {
    const fail = async function* () { yield { kind: "finished" as const, reason: "turn_limit" as const }; };
    const engine = scriptedEngine([fail, fail]);
    const h = harness({ config: cfg(), engine });
    await h.svc.send({ text: "hard task" });
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "turn_limit" });
  });

  it("escalates a delegated child along its role chain without asking the user", async () => {
    const explorer = { id: "explorer", enabled: true, prompt: "", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5, chain: ["a1", "a2"] };
    const fail = async function* () { yield { kind: "finished" as const, reason: "turn_limit" as const }; };
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const tool = turn.tools.find("delegate")!;
        const text = await tool.execute({ role: "explorer", task: "find x" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: `child said: ${text.split("\n")[0]}` });
        yield { kind: "finished", reason: "stop" };
      },
      fail,
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "found x" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config: makeConfig({ agents: twoAgents, roles: [makeConfig().roles[0], explorer] }), engine });
    await h.svc.send({ text: "delegate something" });
    const esc = await h.waitFor("run.escalated");
    expect(esc).toMatchObject({ roleId: "explorer", from: "a1", to: "a2" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.filter((e) => e.kind === "ask_user")).toEqual([]);
  });
});

describe("project verify commands", () => {
  const verifyCfg = (agents: { id: string; channel: string; model: string; effort: "medium" }[] = [{ id: "a", channel: "c", model: "m", effort: "medium" }]) =>
    makeConfig({ agents, project: { verify: [["pnpm", "-r", "typecheck"]] } });
  const make = (config: EffectiveConfig, steps = 1) => {
    let h!: Harness;
    const engine = scriptedEngine(Array.from({ length: steps }, () => async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "edited" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    }));
    h = harness({ config, engine });
    return h;
  };

  it("does not run project verify when nothing changed", async () => {
    const h = harness({ config: verifyCfg() });
    await h.svc.send({ text: "question" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { verified: "none" } });
    expect(h.procs.filter((p) => p.argv[0] === "pnpm")).toEqual([]);
  });

  it("runs project verify after files changed, gated by approval", async () => {
    const h = make(verifyCfg());
    const reqP = h.waitFor("approval.request");
    await h.svc.send({ text: "edit" });
    const req = await reqP;
    expect((req as { args: { command: string[] } }).args.command).toEqual(["pnpm", "-r", "typecheck"]);
    h.interaction.resolveApproval((req as { approvalId: string }).approvalId, "once");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { verified: "command", command: "pnpm -r typecheck" } });
    expect(h.procs.filter((p) => p.argv[0] === "pnpm").length).toBe(1);
  });

  it("denying project verify yields command_denied and a failed run", async () => {
    const h = make(verifyCfg());
    const reqP = h.waitFor("approval.request");
    const askP = h.waitFor("ask_user");
    await h.svc.send({ text: "edit" });
    const req = await reqP;
    h.interaction.resolveApproval((req as { approvalId: string }).approvalId, "deny");
    const check = await h.waitFor("check.result");
    expect((check as { evidence: string[] }).evidence.join(" ")).toContain("check command not approved");
    const ask = await askP;
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed" });
  });

  it("a failing project verify escalates to the next agent", async () => {
    const agents = [
      { id: "a1", channel: "c", model: "m", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m", effort: "medium" as const },
    ];
    const cfg = verifyCfg(agents);
    cfg.roles[0] = { ...cfg.roles[0], chain: ["a1", "a2"] };
    const h = make(cfg, 2);
    let calls = 0;
    h.setProcHandler((argv) => ({ code: argv[0] === "pnpm" ? (calls++ === 0 ? 1 : 0) : 1 }));
    const reqP = h.waitFor("approval.request");
    await h.svc.send({ text: "edit" });
    const req = await reqP;
    h.interaction.resolveApproval((req as { approvalId: string }).approvalId, "always");
    const esc = await h.waitFor("run.escalated");
    expect(esc).toMatchObject({ from: "a1", to: "a2" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done" });
  });
});

describe("one policy decision", () => {
  const tester = { id: "tester", enabled: true, prompt: "t", skills: [], tools: ["ReadFile", "WriteFile", "RunTerminal"], writePaths: ["tests/**"], turnBudget: 5 };
  const cfgWith = (...rs: unknown[]) => makeConfig({ roles: [makeConfig().roles[0], ...(rs as never[])] });

  it("denies claude-code-lead edits on .stewart and .. paths without reaching the gate", async () => {
    let h: Harness;
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const d1 = await turn.approve({ id: "1", name: "Edit", arguments: {} }, { kind: "file", path: ".stewart/plans/x.md", before: null, after: "x" }, {});
        expect(d1).toMatchObject({ kind: "rejected", reason: "path denied: .stewart/plans/x.md" });
        const d2 = await turn.approve({ id: "2", name: "Edit", arguments: {} }, { kind: "file", path: "../outside.txt", before: null, after: "x" }, {});
        expect(d2.kind).toBe("rejected");
        const reqP = h.waitFor("approval.request");
        const ok = turn.approve({ id: "3", name: "Edit", arguments: {} }, { kind: "file", path: "src/a.ts", before: null, after: "x" }, {});
        h.interaction.resolveApproval(((await reqP) as { approvalId: string }).approvalId, "once");
        expect((await ok).kind).toBe("approved");
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ engine });
    await h.svc.send({ text: "edit" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
    const reqs = h.events.filter((e) => e.kind === "approval.request");
    expect(reqs.length).toBe(1);
  });

  it("denies rm but lets ls reach the gate for a read-only child", async () => {
    const ro = { id: "rev", enabled: true, prompt: "r", skills: [], tools: ["ReadFile", "RunTerminal"], writePaths: [], turnBudget: 5 };
    const config = cfgWith(ro);
    let h: Harness;
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        await turn.tools.find("delegate")!.execute({ role: "rev", task: "check" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        const rm = await turn.approve({ id: "1", name: "Bash", arguments: {} }, { kind: "command", command: "rm x" }, {});
        expect(rm.kind).toBe("rejected");
        const reqP = h.waitFor("approval.request");
        const ls = turn.approve({ id: "2", name: "Bash", arguments: {} }, { kind: "command", command: "ls" }, {});
        h.interaction.resolveApproval(((await reqP) as { approvalId: string }).approvalId, "once");
        expect((await ls).kind).toBe("approved");
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "nothing" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
  });
});

describe("policy backstop", () => {
  const tester = { id: "tester", enabled: true, prompt: "t", skills: [], tools: ["ReadFile", "WriteFile", "RunTerminal"], writePaths: ["tests/**"], turnBudget: 5 };
  const rev = { id: "rev", enabled: true, prompt: "r", skills: [], tools: ["ReadFile", "RunTerminal"], writePaths: [], turnBudget: 5 };
  const cfgWith = (...rs: unknown[]) => makeConfig({ roles: [makeConfig().roles[0], ...(rs as never[])] });
  const delegateLead = (roleId: string) =>
    async function* (turn: EngineTurn) {
      const out = await turn.tools.find("delegate")!.execute({ role: roleId, task: "work" }, null, turn.signal);
      turn.transcript.push({ role: "assistant", content: String(out) });
      yield { kind: "finished", reason: "stop" };
    };

  it("fails a writePaths child that changed a file outside its globs", async () => {
    let h: Harness;
    const engine = scriptedEngine([
      delegateLead("tester"),
      async function* (turn: EngineTurn) {
        h.setProcHandler((argv) => {
          if (argv.join(" ").includes("touch")) h.files["src/a.ts"] = "changed by shell";
          return { code: 0 };
        });
        const t = turn.tools.find("RunTerminal")!;
        const pv = await t.preview!({ command: "touch src/a.ts" });
        await t.execute({ command: "touch src/a.ts" }, pv, turn.signal);
        turn.transcript.push({ role: "assistant", content: "touched" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ config: cfgWith(tester), engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    const check = h.events.find((e) => e.kind === "check.result") as { passed: boolean; evidence: string[] };
    expect(check.passed).toBe(false);
    expect(check.evidence.some((d) => d.includes("changed outside role policy: src/a.ts"))).toBe(true);
  });

  it("fails a read-only child whose run changed a file", async () => {
    let h: Harness;
    const engine = scriptedEngine([
      delegateLead("rev"),
      async function* (turn: EngineTurn) {
        h.setProcHandler((argv) => {
          if (argv.join(" ").includes("echo")) h.files["src/b.ts"] = "written";
          return { code: 0 };
        });
        const t = turn.tools.find("RunTerminal")!;
        const pv = await t.preview!({ command: "echo hi" });
        await t.execute({ command: "echo hi" }, pv, turn.signal);
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "saw it" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    h = harness({ config: cfgWith(rev), engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    const check = h.events.find((e) => e.kind === "check.result") as { passed: boolean; evidence: string[] };
    expect(check.passed).toBe(false);
    expect(check.evidence.some((d) => d.includes("changed outside role policy: src/b.ts"))).toBe(true);
  });

  it("does not backstop an unrestricted lead", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "did a thing" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "src/c.ts": "lead wrote" } });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
    const check = h.events.find((e) => e.kind === "check.result") as { evidence: string[] };
    expect(check.evidence.every((d) => !d.includes("changed outside role policy"))).toBe(true);
  });
});

describe("child read/write lock", () => {
  const explorer = { id: "explorer", enabled: true, prompt: "", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };
  const writer = { id: "writer", enabled: true, prompt: "", skills: [], tools: ["WriteFile"], writePaths: [], turnBudget: 5 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("a writer waits for a running reader and blocks a later reader", async () => {
    const order: string[] = [];
    const config = makeConfig({ roles: [makeConfig().roles[0], explorer, writer] });
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const tool = turn.tools.find("delegate")!;
        await Promise.all([
          tool.execute({ role: "explorer", task: "r1" }, null, turn.signal),
          (async () => { await sleep(5); await tool.execute({ role: "writer", task: "w" }, null, turn.signal); })(),
          (async () => { await sleep(10); await tool.execute({ role: "explorer", task: "r2" }, null, turn.signal); })(),
        ]);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        order.push("r1s");
        await sleep(40);
        order.push("r1e");
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "r1" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        order.push("ws");
        order.push("we");
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "w" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        order.push("r2s");
        order.push("r2e");
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: "r2" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
    expect(order.indexOf("ws")).toBeGreaterThan(order.indexOf("r1e"));
    expect(order.indexOf("r2s")).toBeGreaterThan(order.indexOf("we"));
  });

  it("two readers overlap", async () => {
    const order: string[] = [];
    const config = makeConfig({ roles: [makeConfig().roles[0], explorer] });
    const step = (tag: string) =>
      async function* (turn: EngineTurn) {
        order.push(`${tag}s`);
        await sleep(30);
        order.push(`${tag}e`);
        yield* readOnce();
        turn.transcript.push({ role: "assistant", content: tag });
        yield { kind: "finished", reason: "stop" };
      };
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const tool = turn.tools.find("delegate")!;
        await Promise.all([
          tool.execute({ role: "explorer", task: "a" }, null, turn.signal),
          tool.execute({ role: "explorer", task: "b" }, null, turn.signal),
        ]);
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
      step("a"),
      step("b"),
    ]);
    const h = harness({ config, engine });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
    expect(order).toEqual(["as", "bs", "ae", "be"]);
  });
});

describe("engine contract: caps and complete", () => {
  const chatCountChannel = () => {
    let chats = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        chats++;
        yield { kind: "text", text: "x".repeat(120_000) };
        yield { kind: "done" };
      },
    };
    return { channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }), chats: () => chats };
  };

  it("skips compaction when the engine caps say it owns context", async () => {
    const { channel, chats } = chatCountChannel();
    const engine: Engine = { ...nativeLoop, caps: { ownTools: true, ownContext: true } };
    const h = harness({ engine, channel });
    const { sessionId } = await h.svc.send({ text: "one" });
    await h.waitFor("run.finished");
    for (const text of ["two", "three"]) {
      await h.svc.send({ text, sessionId });
      await h.waitFor("run.finished");
    }
    expect(chats()).toBe(3);
  });

  it("compacts for an engine that does not own context", async () => {
    const { channel, chats } = chatCountChannel();
    const h = harness({ engine: nativeLoop, channel });
    const { sessionId } = await h.svc.send({ text: "one" });
    await h.waitFor("run.finished");
    for (const text of ["two", "three"]) {
      await h.svc.send({ text, sessionId });
      await h.waitFor("run.finished");
    }
    expect(chats()).toBe(4);
  });

  it("routes a kind:function delegate to the channel engine's complete", async () => {
    const fn = { id: "scorer", enabled: true, prompt: "Score it.", skills: [], tools: [], writePaths: [], turnBudget: 1, kind: "function" as const };
    const base = makeConfig();
    const config = makeConfig({
      roles: [base.roles[0], fn],
      channels: [{ ...base.channels[0], type: "claude-cli", modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 }, function: { passed: true, at: 1, version: 2, context: 32000 } } } } }],
    });
    const completes: { schema: unknown; type: string }[] = [];
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const t = turn.tools.find("delegate")!;
        const out = await t.execute({ role: "scorer", task: "x", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: String(out) });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const cc: Engine = {
      id: "claude-code",
      caps: { ownTools: true, ownContext: true },
      run: (turn) => engine.run(turn),
      complete: async (req) => {
        completes.push({ schema: req.schema, type: req.channel.cfg.type });
        return { ok: true, value: { n: 7 } };
      },
    };
    const adapter: ChannelAdapter = { type: "claude-cli", listModels: async () => ["m"], probeCaps: async () => ({}), chat: async function* () {} };
    const claudeChannel = new ManagedChannel(adapter, { id: "c", type: "claude-cli", enabled: true, maxParallel: 1 });
    const h = harness({ config, engine: cc, channel: claudeChannel });
    await h.svc.send({ text: "go" });
    expect((await h.waitFor("run.finished")).status).toBe("done");
    expect(completes).toHaveLength(1);
    expect(completes[0].type).toBe("claude-cli");
    const done = h.events.find((e) => e.kind === "task.done") as { summary: string };
    expect(done.summary).toContain('"n":7');
  });

  it("fails the function delegate when complete errors", async () => {
    const fn = { id: "scorer", enabled: true, prompt: "s", skills: [], tools: [], writePaths: [], turnBudget: 1, kind: "function" as const };
    const base = makeConfig();
    const config = makeConfig({
      roles: [base.roles[0], fn],
      channels: [{ ...base.channels[0], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 }, function: { passed: true, at: 1, version: 2, context: 32000 } } } } }],
    });
    const outs: string[] = [];
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const t = turn.tools.find("delegate")!;
        outs.push(String(await t.execute({ role: "scorer", task: "x", schema: { type: "object" } }, null, turn.signal)));
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const failing: Engine = { ...engine, complete: async () => ({ ok: false, error: "cli gone" }) };
    const h = harness({ config, engine: failing });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(outs[0]).toContain("status: failed");
    expect(outs[0]).toContain("cli gone");
  });
});

describe("SessionService incremental persistence and retention", () => {
  const storedChat = (sessionId: string, messages: unknown[]) =>
    JSON.stringify({ version: 1, sessionId, title: "t", savedAt: 1, messages });

  it("persists the user message before the engine starts", async () => {
    let seenAtStart: unknown;
    let h!: Harness;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "none" }),
      async *run(turn: EngineTurn) {
        const path = `/tmp/st/history/${turn.sessionId}.json`;
        seenAtStart = h.files[path] && JSON.parse(h.files[path]).messages.at(-1);
        turn.transcript.push({ role: "assistant", content: "hi" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    h = harness({ engine });
    await h.svc.send({ text: "hello there" });
    await h.waitFor("run.finished");
    expect(seenAtStart).toMatchObject({ role: "user", content: "hello there" });
  });

  it("writes the transcript after the first tool outcome while the engine is still running", async () => {
    let mid: { role: string }[] = [];
    let h!: Harness;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "none" }),
      async *run(turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ReadFile", arguments: {} }] });
        turn.transcript.push({ role: "tool", toolCallId: "c1", content: "result" });
        yield { kind: "tool.request", callId: "c1", tool: "ReadFile", args: {}, category: "OTHER" };
        yield { kind: "tool.outcome", callId: "c1", ok: true, summary: "r" };
        await new Promise((r) => setTimeout(r));
        mid = JSON.parse(h.files[`/tmp/st/history/${turn.sessionId}.json`]).messages;
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    h = harness({ engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(mid.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("repairs interrupted tool calls on load but leaves a trailing user message", async () => {
    const seen: string[][] = [];
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "none" }),
      async *run(turn: EngineTurn) {
        seen.push(turn.transcript.map((m) => (m.role === "tool" ? `${m.role}:${m.content.slice(0, 11)}` : m.role)));
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({
      engine,
      files: {
        "/tmp/st/history/sess-a.json": storedChat("sess-a", [
          { role: "user", content: "first" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "T", arguments: {} }, { id: "c2", name: "T", arguments: {} }] },
          { role: "tool", toolCallId: "c1", content: "done" },
        ]),
        "/tmp/st/history/sess-b.json": storedChat("sess-b", [{ role: "user", content: "unreplied" }]),
      },
    });
    await h.svc.send({ sessionId: "sess-a", text: "again" });
    await h.waitFor("run.finished");
    expect(seen[0]).toEqual(["user", "assistant", "tool:done", "tool:Interrupted", "user"]);
    await h.svc.send({ sessionId: "sess-b", text: "again" });
    await h.waitFor("run.finished");
    expect(seen[1]).toEqual(["user", "user"]);
  });

  it("persists a child transcript incrementally", async () => {
    const reviewer = { id: "reviewer", enabled: true, prompt: "You review.", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };
    let mid = false;
    let h!: Harness;
    let n = 0;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: async () => ({ ok: false as const, error: "none" }),
      async *run(turn: EngineTurn) {
        if (n++ === 0) {
          const t = turn.tools.find("delegate")!;
          await t.execute({ role: "reviewer", task: "look" }, null, turn.signal);
          turn.transcript.push({ role: "assistant", content: "done" });
          yield { kind: "finished", reason: "stop" };
          return;
        }
        turn.transcript.push({ role: "assistant", content: "", toolCalls: [{ id: "x", name: "ReadFile", arguments: {} }] });
        yield { kind: "tool.request", callId: "x", tool: "ReadFile", args: {}, category: "OTHER" };
        yield { kind: "tool.outcome", callId: "x", ok: true, summary: "r" };
        await new Promise((r) => setTimeout(r));
        mid = Object.keys(h.files).some((k) => k.includes(`/sessions/${turn.sessionId.split("/")[0]}/`));
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    h = harness({ config: makeConfig({ roles: [makeConfig().roles[0], reviewer] }), engine });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished");
    expect(mid).toBe(true);
  });

  it("drops the chains entry once a turn settles", async () => {
    const h = harness();
    const { sessionId } = await h.svc.send({ text: "one" });
    const fin1 = await h.waitFor("run.finished");
    expect(fin1).toMatchObject({ status: "done" });
    await new Promise((r) => setTimeout(r));
    const chains = (h.svc as unknown as { chains: Map<string, Promise<void>> }).chains;
    expect(chains.has(sessionId)).toBe(false);
    await h.svc.send({ sessionId, text: "two" });
    await h.waitFor("run.finished");
    await new Promise((r) => setTimeout(r));
    expect(chains.has(sessionId)).toBe(false);
  });

  it("delete removes tracker and every session artifact", async () => {
    const h = harness({ files: { "/tmp/st/history/dead.json": storedChat("dead", [{ role: "user", content: "x" }]) } });
    const paths = [
      "/tmp/st/sessions/dead.engine.json",
      "/tmp/st/sessions/dead.turn",
      "/tmp/st/sessions/dead.plan",
      "/tmp/st/sessions/dead.archive.jsonl",
      "/tmp/st/sessions/dead/task-1.json",
      "/tmp/st/checkpoints/dead/manifest.json",
      "/tmp/st/checkpoints/dead/blobs/ab12",
      "/tmp/st/checkpoints/dead.index",
      "/p/.stewart/plans/dead.md",
    ];
    for (const p of paths) h.files[p] = "x";
    await (await h.svc.historyStore()).delete("dead");
    expect(h.files["/tmp/st/history/dead.json"]).toBeUndefined();
    for (const p of paths) expect(h.files[p]).toBeUndefined();
  });

  it("delete asks git to drop the session ref and ignores failure", async () => {
    const h = harness({ files: { "/tmp/st/history/dead.json": storedChat("dead", [{ role: "user", content: "x" }]) } });
    const calls: string[][] = [];
    h.setProcHandler((argv, onData) => {
      calls.push(argv);
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") {
        onData("true\n");
        return { code: 0 };
      }
      return { code: 128 };
    });
    await (await h.svc.historyStore()).delete("dead");
    expect(calls).toContainEqual(["git", "update-ref", "-d", "refs/stewart/dead"]);
  });
});
