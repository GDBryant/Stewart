import { describe, expect, it } from "vitest";
import type { EngineTurn } from "@stewart/engines";
import { harness, scriptedEngine } from "./harness.js";

const said = (text: string) =>
  async function* (turn: EngineTurn) {
    turn.transcript.push({ role: "assistant", content: text });
    yield { kind: "finished" as const, reason: "stop" as const };
  };

describe("lead turn checks", () => {
  it("fails an edit request that changed no file", async () => {
    const h = harness({ engine: scriptedEngine([said("Fixed it.")]) });
    await h.svc.send({ text: "fix the failing test" });
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "failed", error: "edit request: no file changed" });
  });

  it("passes an edit request whose change only shows in the git worktree (shell edit)", async () => {
    const h = harness({ engine: scriptedEngine([said("Fixed with sed.")]) });
    let statusCalls = 0;
    h.setProcHandler((argv, onData) => {
      if (argv[1] === "status") {
        statusCalls++;
        onData(statusCalls === 1 ? "" : " M src/a.ts\0");
      } else if (argv[1] === "hash-object") onData("abc123\n");
      return { code: 0 };
    });
    await h.svc.send({ text: "fix the failing test" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("does not require a change for questions", async () => {
    const h = harness({ engine: scriptedEngine([said("Use git bisect.")]) });
    await h.svc.send({ text: "how do I fix a flaky test?" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("keys the before-snapshot by the project-relative path, so absolute CLI paths are compared", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "e1", tool: "Edit", args: { file_path: `${turn.cwd}/a.ts` }, category: "FILE" };
        yield { kind: "tool.outcome", callId: "e1", ok: true, summary: "edited" };
        yield { kind: "write", record: { path: "a.ts", ok: true } };
        turn.transcript.push({ role: "assistant", content: "edited a.ts" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.ts": "same" } });
    await h.svc.send({ text: "edit a.ts" });
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    const fin = (await h.waitFor("run.finished")) as { error: string };
    expect(fin.error).toContain("unchanged: a.ts");
  });

  it("runs a declared check command once per turn", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        await turn.tools.find("set_check")!.execute({ command: ["npm", "test"] }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "run tests" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
    expect(h.procs.filter((p) => p.argv[0] === "npm").length).toBe(1);
  });

  it("matches tool outcomes to calls by id in the handover", async () => {
    const engine = scriptedEngine([
      async function* () {
        yield { kind: "tool.request", callId: "a", tool: "ReadFile", args: { path: "a" }, category: "OTHER" };
        yield { kind: "tool.request", callId: "b", tool: "ReadFile", args: { path: "b" }, category: "OTHER" };
        yield { kind: "tool.outcome", callId: "b", ok: true, summary: "ok" };
        yield { kind: "tool.outcome", callId: "a", ok: false, summary: "no such file" };
        yield { kind: "finished", reason: "turn_limit" };
      },
      said("done"),
    ]);
    const agents = [
      { id: "a1", channel: "c", model: "m", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m", effort: "medium" as const },
    ];
    const base = harness().config;
    const h = harness({ engine, config: { ...base, agents, roles: [{ ...base.roles[0], chain: ["a1", "a2"] }] } });
    const { sessionId } = await h.svc.send({ text: "look at a and b" });
    await h.waitFor("run.finished");
    const transcript = await h.svc.fullHistory(sessionId);
    const handover = transcript.find((m) => m.role === "user" && m.content.startsWith("Handover"))!.content;
    expect(handover).toContain('ReadFile({"path":"a"}) failed');
    expect(handover).toContain('ReadFile({"path":"b"}) ok');
  });

  it("fullHistory expands compaction summaries from the archive", async () => {
    const h = harness({ engine: scriptedEngine([said("ok")]) });
    const stateDir = await h.host.workspace.stateDir();
    const store = await h.svc.historyStore();
    await store.save("s1", [{ role: "user", content: "[Summary of earlier conversation] #k\nsum" }, { role: "user", content: "now" }]);
    h.files[`${stateDir}/sessions/s1.archive.jsonl`] = `${JSON.stringify({ chunk: "k", message: { role: "user", content: "first" } })}\n`;
    expect((await h.svc.fullHistory("s1")).map((m) => m.content)).toEqual(["first", "now"]);
    expect(await h.svc.fullHistory("none")).toEqual([]);
  });
});
