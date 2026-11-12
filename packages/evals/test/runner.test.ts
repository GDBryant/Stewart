import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, PROJECT_ID, runTask, runTurn, type RunOpts } from "../src/runner.js";
import type { RunEvent } from "@stewart/protocol";
import type { EvalTask } from "../src/tasks.js";
import type { Workspace } from "../src/workspace.js";

const ev = (e: Partial<RunEvent> & { kind: RunEvent["kind"] }): RunEvent => e as RunEvent;

describe("EventLog", () => {
  it("auto-approves approval.request and answers ask_user", async () => {
    const log = new EventLog();
    const calls: [string, Record<string, unknown>][] = [];
    log.dispatch = async (m, p) => {
      calls.push([m, p]);
      return {};
    };
    log.push(ev({ kind: "approval.request", runId: "r1", approvalId: "a1", tool: "Edit", args: {}, category: "EDITS" }));
    log.push(ev({ kind: "ask_user", runId: "r1", questionId: "q1", question: "?", options: ["yes", "no"], roleId: "lead" }));
    log.push(ev({ kind: "ask_user", runId: "r1", questionId: "q2", question: "?" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["chat.approve", { projectId: PROJECT_ID, approvalId: "a1", grant: "once" }]);
    expect(calls).toContainEqual(["chat.answer", { projectId: PROJECT_ID, questionId: "q1", answer: "yes" }]);
    expect(calls).toContainEqual(["chat.answer", { projectId: PROJECT_ID, questionId: "q2", answer: "Proceed with your best judgment." }]);
  });

  it("wait resolves on run.finished and ignores task-scoped finishes", async () => {
    const log = new EventLog();
    const w = log.wait("r1", 5000);
    log.push(ev({ kind: "run.finished", runId: "r1", status: "done", taskId: "t-1" }));
    log.push(ev({ kind: "run.finished", runId: "r1", status: "done" }));
    expect(await w).toBe(true);
    expect(log.finished("r1")?.status).toBe("done");
    expect(await log.wait("r1", 1)).toBe(true);
  });

  it("wait times out when the run never finishes", async () => {
    const log = new EventLog();
    expect(await log.wait("gone", 20)).toBe(false);
  });

  it("concatenates text and takes the max accrued cost", () => {
    const log = new EventLog();
    log.push(ev({ kind: "text_delta", runId: "r", seq: 0, text: "he" }));
    log.push(ev({ kind: "text_delta", runId: "r", seq: 1, text: "llo" }));
    log.push(ev({ kind: "text_delta", runId: "other", seq: 0, text: "x" }));
    log.push(ev({ kind: "cost.summary", runId: "r", accruedUsd: 0.02, capUsd: 0, overshootUsd: 0, byRole: {}, byAgent: {}, parked: [], freeFinished: [], suggestions: [] }));
    log.push(ev({ kind: "cost.summary", runId: "r", accruedUsd: 0.01, capUsd: 0, overshootUsd: 0, byRole: {}, byAgent: {}, parked: [], freeFinished: [], suggestions: [] }));
    expect(log.text("r")).toBe("hello");
    expect(log.cost("r")).toBe(0.02);
    expect(log.cost("other")).toBe(0);
  });
});

describe("runTurn", () => {
  const ctx = (log: EventLog, dispatch: EventLog["dispatch"], timeoutMs = 5000) => ({ log, dispatch, sessionId: "s", timeoutMs });

  it("returns a send error without waiting", async () => {
    const log = new EventLog();
    const r = await runTurn(ctx(log, async () => {
      throw new Error("no channel");
    }), "hi");
    expect(r.status).toBe("error");
    expect(r.error).toBe("no channel");
    expect(r.reply).toBe("");
  });

  it("returns done with reply from history.load", async () => {
    const log = new EventLog();
    log.dispatch = async (m, p) => {
      if (m === "chat.send") {
        setTimeout(() => log.push(ev({ kind: "run.finished", runId: "r1", status: "done" })), 5);
        return { runId: "r1" };
      }
      if (m === "history.load") return { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "final answer" }] };
      return {};
    };
    const r = await runTurn(ctx(log, log.dispatch), "hi");
    expect(r.status).toBe("done");
    expect(r.reply).toBe("final answer");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to streamed text when history.load fails", async () => {
    const log = new EventLog();
    log.dispatch = async (m) => {
      if (m === "chat.send") {
        setTimeout(() => {
          log.push(ev({ kind: "text_delta", runId: "r2", seq: 0, text: "streamed" }));
          log.push(ev({ kind: "run.finished", runId: "r2", status: "done" }));
        }, 5);
        return { runId: "r2" };
      }
      if (m === "history.load") throw new Error("no store");
      return {};
    };
    const r = await runTurn(ctx(log, log.dispatch), "hi");
    expect(r.reply).toBe("streamed");
  });

  it("times out, cancels, and reports status timeout", async () => {
    const log = new EventLog();
    const calls: string[] = [];
    log.dispatch = async (m) => {
      calls.push(m);
      if (m === "chat.send") return { runId: "r3" };
      if (m === "chat.cancel") setTimeout(() => log.push(ev({ kind: "run.finished", runId: "r3", status: "cancelled" })), 5);
      if (m === "history.load") return { messages: [] };
      return {};
    };
    const r = await runTurn(ctx(log, log.dispatch, 15), "hi");
    expect(r.status).toBe("timeout");
    expect(calls).toContain("chat.cancel");
    expect(r.error).toBeUndefined();
  });
});

describe("runTask", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const fakeStart = (replies: Record<string, unknown>) =>
    async (_ws: Workspace, _opts: RunOpts) => {
      const log = new EventLog();
      const dispatch = async (m: string, p: Record<string, unknown>) => {
        if (m === "chat.send") {
          setTimeout(() => log.push(ev({ kind: "run.finished", runId: "run-x", status: "done" })), 5);
          return { runId: "run-x" };
        }
        if (m === "history.load") return replies;
        return {};
      };
      log.dispatch = dispatch;
      return { log, dispatch };
    };

  const opts = (config: string): RunOpts => ({ config, disableLead: true, keep: "never" });

  it("runs a passing task end to end on a real workspace", async () => {
    const configSrc = await mkdtemp(join(tmpdir(), "evals-cfg-"));
    dirs.push(configSrc);
    const task: EvalTask = {
      id: "fake-pass",
      kind: "question",
      turns: ["hi"],
      check: async (c) => ({ pass: existsSync(c.root), evidence: `root ${c.root}` }),
    };
    const r = await runTask(task, opts(configSrc), { startCore: fakeStart({ messages: [{ role: "assistant", content: "done it" }] }) });
    expect(r.pass).toBe(true);
    expect(r.statusAgrees).toBe(true);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].reply).toBe("done it");
    expect(r.workspace).toBeUndefined();
    expect(r.evidence).toContain("root");
  });

  it("reports check throws as failed evidence and keeps the workspace on keep=failed", async () => {
    const configSrc = await mkdtemp(join(tmpdir(), "evals-cfg-"));
    dirs.push(configSrc);
    const task: EvalTask = {
      id: "fake-fail",
      kind: "edit",
      turns: ["x"],
      check: async () => {
        throw new Error("boom");
      },
    };
    const r = await runTask(task, { ...opts(configSrc), keep: "failed" }, { startCore: fakeStart({ messages: [] }) });
    expect(r.pass).toBe(false);
    expect(r.evidence).toContain("check threw: Error: boom");
    expect(r.statusAgrees).toBe(false);
    expect(r.workspace).toBeTruthy();
    dirs.push(r.workspace!);
  });
});
