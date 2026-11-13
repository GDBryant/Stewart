import { describe, expect, it } from "vitest";
import type { EngineTurn } from "@stewart/engines";
import { harness, scriptedEngine } from "./harness.js";

const said = (text: string) =>
  async function* (turn: EngineTurn) {
    turn.transcript.push({ role: "assistant", content: text });
    yield { kind: "finished" as const, reason: "stop" as const };
  };

describe("lead turn checks", () => {
  it("passes an edit request that changed no file and reports it as not verified", async () => {
    const h = harness({ engine: scriptedEngine([said("Fixed it.")]) });
    await h.svc.send({ text: "fix the failing test" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { changed: [], verified: "none" } });
  });

  it("sees a shell-only edit outside git as changed (manifest tracking)", async () => {
    const h = harness({
      files: { "src/a.ts": "old" },
      engine: scriptedEngine([
        async function* (turn: EngineTurn) {
          h.files["src/a.ts"] = "fixed by sed";
          turn.transcript.push({ role: "assistant", content: "Fixed with sed." });
          yield { kind: "finished", reason: "stop" };
        },
      ]),
    });
    await h.svc.send({ text: "fix the failing test" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { changed: ["src/a.ts"], verified: "none" } });
  });

  it("reports tracking as unavailable over the manifest limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`f${i}.ts`] = "x";
    const h = harness({ files, engine: scriptedEngine([said("done")]) });
    await h.svc.send({ text: "go" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { changed: [], verified: "none", tracking: "unavailable" } });
    expect((fin as { outcome: { trackingReason: string } }).outcome.trackingReason).toContain("2000");
  });

  it("revert 'turn' restores the worktree to the turn baseline", async () => {
    const h = harness({
      files: { "src/a.ts": "old" },
      engine: scriptedEngine([
        async function* (turn: EngineTurn) {
          h.files["src/a.ts"] = "broken";
          h.files["src/new.ts"] = "added";
          turn.transcript.push({ role: "assistant", content: "edited" });
          yield { kind: "finished", reason: "stop" };
        },
      ]),
    });
    const { sessionId } = await h.svc.send({ text: "edit" });
    await h.waitFor("run.finished");
    const r = await h.svc.revert(sessionId, "turn");
    expect(r.ok).toBe(true);
    const back = Buffer.from((await h.host.files.readBinary("src/a.ts")).base64, "base64").toString("utf8");
    expect(back).toBe("old");
    expect("src/new.ts" in h.files).toBe(false);
  });

  it("revert 'turn' without a baseline reports no turn baseline", async () => {
    const h = harness();
    expect(await h.svc.revert("nope", "turn")).toMatchObject({ ok: false, reason: "no turn baseline for this session" });
  });

  it("does not require a change for questions", async () => {
    const h = harness({ engine: scriptedEngine([said("Use git bisect.")]) });
    await h.svc.send({ text: "how do I fix a flaky test?" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });

  it("does not make a write record an implicit required file", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        yield { kind: "tool.request", callId: "e1", tool: "Edit", args: { file_path: `${turn.cwd}/a.ts` }, category: "FILE" };
        yield { kind: "tool.outcome", callId: "e1", ok: true, summary: "edited" };
        yield { kind: "write", record: { path: "a.ts", ok: true } };
        turn.transcript.push({ role: "assistant", content: "edited a.ts" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "edit a.ts" });
    const fin = (await h.waitFor("run.finished")) as { status: string; error?: string };
    expect(fin.status).toBe("done");
  });

  it("runs a declared check command once per turn and reports verified: command", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        await turn.tools.find("set_check")!.execute({ command: ["npm", "test"] }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "run tests" });
    const fin = await h.waitFor("run.finished");
    expect(fin).toMatchObject({ status: "done", outcome: { changed: [], verified: "command", command: "npm test" } });
    expect(h.procs.filter((p) => p.argv[0] === "npm").length).toBe(1);
  });

  it("emits no outcome on cancel", async () => {
    const engine = scriptedEngine([
      async function* () {
        yield { kind: "finished" as const, reason: "cancelled" as const };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "go" });
    const fin = (await h.waitFor("run.finished")) as { status: string; outcome?: unknown };
    expect(fin.status).toBe("cancelled");
    expect(fin.outcome).toBeUndefined();
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

  it("has no set_task tool", async () => {
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        expect(turn.tools.find("set_task")).toBeUndefined();
        expect(turn.tools.find("set_check")).toBeTruthy();
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    await h.svc.send({ text: "how do I fix a flaky test?" });
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
  });
});
