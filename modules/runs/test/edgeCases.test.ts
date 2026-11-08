import { describe, expect, it } from "vitest";
import { EventBus, counterIds, fakeHost, systemClock } from "@stewart/kernel";
import { RunService } from "../src/api.js";
import { parseChatCommand } from "../src/parseCommand.js";
import { DIRECT_TASK_ID, chatRoleDef, timeCapMessage } from "../src/consts.js";
import type { Run } from "../src/types.js";

describe("parseChatCommand", () => {
  it("parses /direct, /quick, /deep and profile flags", () => {
    expect(parseChatCommand("hi")).toEqual({ direct: false, profileName: undefined, text: "hi" });
    expect(parseChatCommand("/direct do x")).toEqual({ direct: true, profileName: undefined, text: "do x" });
    expect(parseChatCommand("/quick go")).toEqual({ direct: false, profileName: "quick", text: "go" });
    expect(parseChatCommand("/deep go")).toEqual({ direct: false, profileName: "deep", text: "go" });
    expect(parseChatCommand("go", "normal")).toEqual({ direct: false, profileName: "normal", text: "go" });
    expect(parseChatCommand("/direct /deep go")).toEqual({ direct: true, profileName: "deep", text: "go" });
    expect(parseChatCommand("go", "bogus")).toEqual({ direct: false, profileName: undefined, text: "go" });
    expect(parseChatCommand("/quickie go").text).toBe("/quickie go");
  });
});

describe("consts", () => {
  it("chatRoleDef and timeCapMessage", () => {
    expect(chatRoleDef().id).toBe("chat");
    expect(timeCapMessage(3_600_000)).toContain("60min");
    expect(DIRECT_TASK_ID).toBe("direct");
  });
});

describe("RunService unit paths", () => {
  function svc() {
    const events: unknown[] = [];
    const { host, files } = fakeHost();
    const s = new RunService({ host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    return { s, host, files, events };
  }

  it("get/register/cancel and approve/answer round-trips", async () => {
    const { s } = svc();
    const run: Run = { id: "r1", projectId: "p", status: "running", controller: new AbortController(), startedAt: 0, messages: [], costUsd: 0 };
    expect(s.get("r1")).toBeUndefined();
    s.register(run);
    expect(s.get("r1")).toBe(run);
    expect(s.cancel("r1")).toBe(true);
    expect(run.status).toBe("cancelled");
    expect(s.cancel("r1")).toBe(false);
    expect(s.cancel("nope")).toBe(false);
    expect(s.approve("x", "once")).toBe(false);
    expect(s.answer("x", "y")).toBe(false);
  });

  it("gate approves instantly when the category is already granted", async () => {
    const { s } = svc();
    const { Grants } = await import("@stewart/permissions");
    const runGrants = new Grants();
    runGrants.record("chat", "OTHER", null);
    const gate = s.gate("r1", runGrants);
    expect((await gate({ id: "c2", name: "X", arguments: {} }, null)).kind).toBe("approved");
  });

  it("interaction approval/answer resolve through the service", async () => {
    const { s } = svc();
    const { approvalPrompt, questionPrompt } = await import("@stewart/interaction");
    const p = s.interaction.ask(approvalPrompt("WriteFile", {}, "EDITS"), { runId: "r1" });
    const id = s.interaction.pending()[0].id;
    expect(s.approve(id, "once")).toBe(true);
    expect(await p).toEqual({ kind: "answered", value: "once" });
    const q = s.interaction.ask(questionPrompt("ask_user", "q?", ["yes"]), { runId: "r1" });
    const qid = s.interaction.pending()[0].id;
    expect(s.answer(qid, "yes")).toBe(true);
    expect(await q).toEqual({ kind: "answered", value: "yes" });
  });

  it("journal writes best-effort and tolerates failures", async () => {
    const { s, files } = svc();
    const run: Run = { id: "r1", projectId: "p", status: "done", controller: new AbortController(), startedAt: 1, messages: [{ role: "user", content: "hi" }], costUsd: 0.5, tasks: [] };
    expect(s.journalPath("r1", "/st")).toBe("/st/scratch/r1/run.json");
    await s.journal(run, "/st");
    expect(files["/st/scratch/r1/run.json"]).toContain('"costUsd":0.5');
  });

  it("saveHistory skips runs without sessionId and swallows store errors", async () => {
    const { s } = svc();
    const run: Run = { id: "r1", projectId: "p", status: "done", controller: new AbortController(), startedAt: 1, messages: [], costUsd: 0 };
    await s.saveHistory(run);
    run.sessionId = "s1";
    await s.saveHistory(run);
    // break the host: files.writeAtomic throws
    (s.deps.host.files as unknown as { writeAtomic: unknown }).writeAtomic = async () => {
      throw new Error("disk full");
    };
    await s.saveHistory(run);
  });

  it("revert refuses a running run and reports absent snapshots", async () => {
    const { s } = svc();
    const run: Run = { id: "r1", projectId: "p", status: "running", controller: new AbortController(), startedAt: 0, messages: [], costUsd: 0 };
    s.register(run);
    expect((await s.revert("r1")).reason).toBe("run is still running");
    expect((await s.revert("nope")).reason).toBe("no snapshots for run");
  });

  it("historyStore returns a working store", async () => {
    const { s } = svc();
    const st = await s.historyStore();
    expect(await st.list()).toEqual([]);
  });

  it("revert restores snapshotted files and emits run.reverted", async () => {
    const { s, files, events } = svc();
    const { recordPreImage } = await import("@stewart/run-state");
    files["a.ts"] = "old";
    await recordPreImage(s.deps.host, "/tmp/st", "r1", "a.ts");
    files["a.ts"] = "new";
    const res = await s.revert("r1");
    expect(res.ok).toBe(true);
    expect(files["a.ts"]).toBe("old");
    expect((events as { kind: string }[]).some((e) => e.kind === "run.reverted")).toBe(true);
  });
});

function svcQ() {
  const events: unknown[] = [];
  const { host } = fakeHost();
  return { s: new RunService({ host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) }), events };
}

describe("prompt queue through the service", () => {
  it("two concurrent approvals emit one at a time in FIFO order", async () => {
    const { s, events } = svcQ();
    const { approvalPrompt } = await import("@stewart/interaction");
    const p1 = s.interaction.ask(approvalPrompt("WriteFile", {}, "EDITS"), { runId: "r1", roleId: "w", taskId: "t1" });
    const p2 = s.interaction.ask(approvalPrompt("RunTerminal", {}, "CMDS"), { runId: "r1", roleId: "w", taskId: "t2" });
    const reqs = (events as { kind: string; approvalId?: string; tool?: string }[]).filter((e) => e.kind === "approval.request");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tool).toBe("WriteFile");
    expect(s.approve(reqs[0].approvalId!, "once")).toBe(true);
    await p1;
    expect(s.interaction.pending()).toHaveLength(1);
    expect(s.approve(s.interaction.pending()[0].id, "chat")).toBe(true);
    await p2;
  });

  it("a run cancel withdraws the pending question card", async () => {
    const { s, events } = svcQ();
    const { questionPrompt } = await import("@stewart/interaction");
    const ac = new AbortController();
    const p = s.interaction.ask(questionPrompt("ask_user", "q?", ["a"]), { runId: "r1", roleId: "w" }, ac.signal);
    ac.abort();
    expect(await p).toEqual({ kind: "withdrawn", reason: "cancel" });
    expect((events as { kind: string }[]).some((e) => e.kind === "question.withdrawn")).toBe(true);
    expect(s.interaction.pending()).toHaveLength(0);
  });
});

describe("gate and prompt meta paths", () => {
  it("gate passes meta roleId/taskId through and withdrawn becomes denied", async () => {
    const { s } = svcQ();
    const { Grants } = await import("@stewart/permissions");
    const ac = new AbortController();
    const gate = s.gate("r1", new Grants(), ac.signal);
    const p = gate({ id: "c1", name: "WriteFile", arguments: {} }, null, { roleId: "w", taskId: "t9" });
    const view = s.interaction.pending()[0];
    expect(view).toMatchObject({ roleId: "w", taskId: "t9", kind: "approval" });
    ac.abort();
    expect((await p).kind).toBe("rejected");
  });

  it("prompt falls back to the default roleId and honours explicit tags", async () => {
    const { s } = svcQ();
    const { questionPrompt } = await import("@stewart/interaction");
    const ask = s.prompt("r1", new AbortController().signal, "orchestrator");
    void ask(questionPrompt("ask_user", "a?"));
    expect(s.interaction.pending()[0].roleId).toBe("orchestrator");
    const p = ask(questionPrompt("ask_user", "b?"), { roleId: "w", taskId: "t1" });
    void p;
    expect(s.interaction.pending()[1]).toMatchObject({ roleId: "w", taskId: "t1" });
  });
});
