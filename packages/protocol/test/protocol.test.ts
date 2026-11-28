import { describe, expect, it } from "vitest";
import { METHODS, negotiate, runEventSchema, PROTOCOL_VERSION } from "../src/index.js";

describe("protocol", () => {
  it("accepts every declared run event kind", () => {
    for (const kind of [
      "run.started", "run.finished", "text_delta", "reasoning_delta", "terminal_output",
      "task.created", "task.started", "task.done", "task.failed", "task.repair",
      "tool.request", "tool.outcome", "ask_user", "question.withdrawn", "approval.request",
      "milestone.started", "milestone.done", "milestone.failed",
      "run.reverted", "cost.summary",
      "cost.limit_reached", "cost.limit_raised", "check.result", "engine.context",
      "chat.local", "chat.cleared",
    ]) {
      const ev = { kind, runId: "r1", seq: 0, text: "", questionId: "q", answer: "a", answeredBy: "orchestrator", approvalId: "a", tool: "t", args: {}, category: "c", callId: "x", ok: true, summary: "s", title: "t", waitingOn: "w", milestoneId: "m", milestoneCount: 1, verdict: "approve", reasons: [], findings: 0, filesRestored: ["a.ts"], capUsd: 1, accruedUsd: 1, overshootUsd: 0, byRole: {}, byAgent: {}, agentId: "a", reason: "r", roleId: "ro", error: "e", status: "done", question: "q?", options: [], passed: true, evidence: ["e1"], outcome: { changed: ["a.ts"], verified: "command", command: "npm test" }, engineSessionId: "cli", inputTokens: 1, windowTokens: 2, compacted: false, turnCount: 3, contextAtFailure: "1/2" };
      expect(runEventSchema.safeParse(ev).success, kind).toBe(true);
    }
  });

  it("parses run.finished with and without outcome", () => {
    const base = { kind: "run.finished", runId: "r", status: "done" };
    expect(runEventSchema.safeParse(base).success).toBe(true);
    const withOutcome = { ...base, contextAtFailure: "123/1000000", outcome: { changed: ["a.ts", "b.ts"], verified: "files" } };
    const r = runEventSchema.safeParse(withOutcome);
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === "run.finished") {
      expect(r.data.outcome).toEqual({ changed: ["a.ts", "b.ts"], verified: "files" });
      expect(r.data.contextAtFailure).toBe("123/1000000");
    }
    expect(runEventSchema.safeParse({ ...base, outcome: { changed: [], verified: "bogus" } }).success).toBe(false);
  });

  it("parses chat.cleared with and without sessionId", () => {
    expect(runEventSchema.safeParse({ kind: "chat.cleared", runId: "r" }).success).toBe(true);
    expect(runEventSchema.safeParse({ kind: "chat.cleared", runId: "r", sessionId: "s1" }).success).toBe(true);
  });

  it("rejects an event with unknown kind", () => {
    expect(runEventSchema.safeParse({ kind: "nope", runId: "r" }).success).toBe(false);
  });

  it("negotiates shared capabilities on equal versions", () => {
    const r = negotiate({ protocol: PROTOCOL_VERSION, capabilities: ["stream_events", "images", "bogus"] }, { protocol: PROTOCOL_VERSION, capabilities: ["stream_events"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities).toEqual(["stream_events"]);
  });

  it("refuses a major version mismatch with actionable error", () => {
    const r = negotiate({ protocol: 1, capabilities: [] }, { protocol: 2, capabilities: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mismatch");
  });

  it("declares all RPC methods", () => {
    expect(METHODS).toContain("chat.send");
    expect(METHODS).toContain("permissions.bypass");
    expect(METHODS).toContain("history.list");
    expect(METHODS).toContain("history.load");
    expect(METHODS).toContain("history.delete");
    expect(METHODS).toContain("slash.list");
    expect(METHODS).toContain("channel.probe");
    expect(METHODS).toContain("setup.probe.start");
    expect(METHODS).toContain("setup.probe.status");
    expect(METHODS).toContain("setup.probe.cancel");
    expect(METHODS).toContain("setup.probe.retry");
    expect(METHODS).toContain("setup.session.addChannel");
    expect(METHODS).toContain("setup.session.removeChannel");
    expect(METHODS.length).toBe(42);
  });
});
