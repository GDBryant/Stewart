import { describe, expect, it } from "vitest";
import { METHODS, negotiate, runEventSchema, PROTOCOL_VERSION } from "../src/index.js";

describe("protocol", () => {
  it("accepts every declared run event kind", () => {
    for (const kind of [
      "run.started", "run.finished", "text_delta", "reasoning_delta", "terminal_output",
      "task.created", "task.started", "task.blocked", "task.done", "task.failed",
      "tool.request", "tool.outcome", "ask_user", "question.answered", "approval.request",
      "milestone.started", "milestone.done", "milestone.failed", "plan.created", "plan.validated", "plan.approved",
      "review.done", "run.reverted",
      "cost.limit_reached", "cost.limit_raised", "cost.replaced", "compaction", "check.result",
    ]) {
      const ev = { kind, runId: "r1", seq: 0, text: "", questionId: "q", answer: "a", answeredBy: "orchestrator", approvalId: "a", tool: "t", args: {}, category: "c", callId: "x", ok: true, summary: "s", title: "t", dependsOn: [], waitingOn: "w", milestoneId: "m", milestoneCount: 1, verdict: "approve", reasons: [], findings: 0, filesRestored: ["a.ts"], capUsd: 1, accruedUsd: 1, agentId: "a", reason: "r", roleId: "ro", droppedTokens: 0, error: "e", status: "done", question: "q?", options: [], passed: true, evidence: ["e1"] };
      expect(runEventSchema.safeParse(ev).success, kind).toBe(true);
    }
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
    expect(METHODS).toContain("chat.revert");
    expect(METHODS).toContain("channel.probe");
    expect(METHODS).toContain("setup.probe.start");
    expect(METHODS).toContain("setup.probe.status");
    expect(METHODS).toContain("setup.probe.cancel");
    expect(METHODS).toContain("setup.probe.retry");
    expect(METHODS).toContain("setup.session.addChannel");
    expect(METHODS).toContain("setup.session.removeChannel");
    expect(METHODS.length).toBe(28);
  });
});
