import { describe, expect, it } from "vitest";
import { EventBus, counterIds, systemClock, type ToolCall } from "@stewart/kernel";
import { Interaction, type PromptOutcome } from "@stewart/interaction";
import { Grants, Permissions, type PermissionRequest, type ToolPreview } from "../src/api.js";

const cmd = (command: string): ToolPreview => ({ kind: "command", command, cwd: "/w" });
const call = (name: string): ToolCall => ({ id: "c1", name, arguments: {} });
const req = (preview: ToolPreview | null): PermissionRequest => ({ tool: "T", args: {}, preview });

function fake(script: PromptOutcome<unknown>) {
  const asks: { prompt: unknown; tag: unknown; signal?: AbortSignal }[] = [];
  const ask = <A>(prompt: unknown, tag: unknown, signal?: AbortSignal) => {
    asks.push({ prompt, tag, signal });
    return Promise.resolve(script as PromptOutcome<A>);
  };
  return { asks, interaction: { ask } };
}

describe("Permissions.decide", () => {
  const p = new Permissions({ ask: () => Promise.resolve({ kind: "answered", value: "once" }) });

  it("allows on a run grant and on a session grant; asks when neither", () => {
    const runGrants = new Grants();
    expect(p.decide(req(cmd("ls")), runGrants)).toBe("ask");
    runGrants.record("chat", "COMMANDS", cmd("ls"));
    expect(p.decide(req(cmd("ls")), runGrants)).toBe("allow");
    const sessionP = new Permissions({ ask: () => Promise.resolve({ kind: "answered", value: "always" }) });
    const run2 = new Grants();
    void sessionP.ask(req(cmd("pwd")), run2, { runId: "r" });
    return sessionP.ask(req(cmd("pwd")), run2, { runId: "r" }).then(() => {
      expect(sessionP.decide(req(cmd("pwd")), new Grants())).toBe("allow");
    });
  });

  it("fails closed to ask when categoryOf throws", () => {
    const bad = new Proxy({}, { get: () => { throw new Error("boom"); } }) as ToolPreview;
    expect(p.decide(req(bad), new Grants())).toBe("ask");
  });
});

describe("Permissions.ask", () => {
  const runId = "r1";

  it("once approves without recording a grant", async () => {
    const f = fake({ kind: "answered", value: "once" });
    const p = new Permissions(f.interaction);
    const runGrants = new Grants();
    expect(await p.ask(req(cmd("ls")), runGrants, { runId })).toEqual({ kind: "approved" });
    expect(p.decide(req(cmd("ls")), runGrants)).toBe("ask");
    expect(f.asks).toHaveLength(1);
  });

  it("chat approves and records a run grant only", async () => {
    const f = fake({ kind: "answered", value: "chat" });
    const p = new Permissions(f.interaction);
    const runGrants = new Grants();
    expect(await p.ask(req(cmd("ls")), runGrants, { runId })).toEqual({ kind: "approved" });
    expect(p.decide(req(cmd("ls")), runGrants)).toBe("allow");
    expect(p.decide(req(cmd("ls")), new Grants())).toBe("ask");
  });

  it("always approves and records a session grant covering fresh runGrants", async () => {
    const f = fake({ kind: "answered", value: "always" });
    const p = new Permissions(f.interaction);
    expect(await p.ask(req(cmd("ls")), new Grants(), { runId })).toEqual({ kind: "approved" });
    expect(p.decide(req(cmd("ls")), new Grants())).toBe("allow");
  });

  it("deny rejects as denied by user; withdrawn rejects too", async () => {
    const denied = fake({ kind: "answered", value: "deny" });
    const p = new Permissions(denied.interaction);
    expect(await p.ask(req(cmd("ls")), new Grants(), { runId })).toEqual({ kind: "rejected", reason: "denied by user" });
    const withdrawn = fake({ kind: "withdrawn", reason: "cancel" });
    const p2 = new Permissions(withdrawn.interaction);
    expect((await p2.ask(req(cmd("ls")), new Grants(), { runId })).kind).toBe("rejected");
  });
});

describe("Permissions.gate", () => {
  it("passes runId/roleId/taskId tag and the signal through to ask", async () => {
    const f = fake({ kind: "answered", value: "once" });
    const p = new Permissions(f.interaction);
    const ac = new AbortController();
    const approve = p.gate("r7", ac.signal, new Grants());
    expect((await approve(call("WriteFile"), null, { roleId: "w", taskId: "t9" })).kind).toBe("approved");
    expect(f.asks[0].tag).toEqual({ runId: "r7", roleId: "w", taskId: "t9" });
    expect(f.asks[0].signal).toBe(ac.signal);
  });

  it("defaults runGrants to a fresh set per gate", async () => {
    const f = fake({ kind: "answered", value: "chat" });
    const p = new Permissions(f.interaction);
    const g1 = p.gate("r1", new AbortController().signal);
    const g2 = p.gate("r2", new AbortController().signal);
    await g1(call("T"), cmd("ls"));
    expect((await g1(call("T"), cmd("ls"))).kind).toBe("approved");
    expect(f.asks).toHaveLength(1);
    await g2(call("T"), cmd("ls"));
    expect(f.asks).toHaveLength(2);
  });
});

describe("Permissions with a real Interaction", () => {
  it("abort withdraws the approval card and rejects", async () => {
    const interaction = new Interaction({ ids: counterIds(), clock: systemClock, bus: new EventBus(() => {}, 0) });
    const p = new Permissions(interaction);
    const ac = new AbortController();
    const pending = p.gate("r1", ac.signal, new Grants())(call("WriteFile"), null);
    ac.abort();
    expect((await pending).kind).toBe("rejected");
    expect(interaction.pending()).toHaveLength(0);
  });
});
