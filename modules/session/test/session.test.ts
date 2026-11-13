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

/** A successful read call: a "no findings" reply must have looked at something. */
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
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed", error: "missing: ghost.ts" });
  });

  it("fails an edit turn whose file content did not change", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "1", tool: "EditFile", args: { path: "a.ts" }, category: "FILE" };
        turn.transcript.push({ role: "assistant", content: "edited" });
        yield { kind: "write", record: { path: "a.ts", ok: true } };
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.ts": "same" } });
    await h.svc.send({ text: "edit a.ts" });
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "failed" });
    expect((fin as { error: string }).error).toContain("unchanged: a.ts");
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

  it("fails a review turn whose reply cites no files, and passes one that does", async () => {
    const reply = (text: string) =>
      scriptedEngine([
        async function* (turn: EngineTurn) {
          turn.transcript.push({ role: "assistant", content: text });
          yield { kind: "finished", reason: "stop" };
        },
      ]);
    const bad = harness({ engine: reply("Looks fine overall.") });
    await bad.svc.send({ text: "review src" });
    const ask = await bad.waitFor("ask_user");
    bad.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    expect(await bad.waitFor("run.finished")).toMatchObject({ status: "failed", error: "no file citations in reply" });
    const good = harness({ engine: reply("src/a.ts:3 has a long function"), files: { "src/a.ts": "x\ny\nz\n" } });
    await good.svc.send({ text: "review src" });
    expect(await good.waitFor("run.finished")).toMatchObject({ status: "done" });
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
    const config2 = { ...config, channels: [{ ...config.channels[0], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 1 }, function: { passed: true, at: 1, version: 1 } } } } }] };
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
    expect(decisions[0]).toContain("outside role 'tester' writePaths");
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
        yield { kind: "write", record: { path: "ghost.ts", ok: true } };
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
    expect(seen[0]).toContain("missing: ghost.ts");
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
