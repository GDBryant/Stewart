import { describe, expect, it } from "vitest";
import { fakeHost, type ChatMessage } from "@stewart/kernel";
import type { AgentDef, RoleDef } from "@stewart/config";
import type { Config } from "@stewart/roles-skills";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import { RunLedger } from "@stewart/ledger";
import { LeaseManager, type TaskSpec } from "@stewart/scheduling";
import type { RunRuntime, TaskResult } from "@stewart/run-contract";
import { continueQuestion, createRecovery, type RecoveryPlan } from "../src/api.js";
import { submitRecoveryTool } from "../src/plan.js";
import { assembleFinalFile, splitTask } from "../src/split.js";
import { recoveryBrain, recoveryCall } from "../src/brain.js";
import { SIZE_HINT, ensureRecovery, logRecovery } from "../src/consts.js";

const role = (tools = ["WriteFile"]): RoleDef => ({ id: "w", name: "w", prompt: "", tools, writePaths: [], enabled: true, turnBudget: 5 }) as unknown as RoleDef;
const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };
const spec: TaskSpec = { id: "t1", roleId: "w", title: "t", task: "do it", files: [], dependsOn: [] };

function mkRt(over: Partial<RunRuntime> = {}) {
  const { host, files } = fakeHost();
  const logged: string[] = [];
  const channel = new ManagedChannel(
    {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {},
    },
    { id: "c", type: "fake", enabled: true, maxParallel: 1 },
  );
  const settings = {
    maxRecoveryDepth: 2, maxRecoveriesPerRun: 3, maxSubTasks: 4, recoverySummaryChars: 60,
    maxActionsInRecoveryBrief: 5, maxContinuations: 2, maxContinueQuestionsPerRun: 3,
    askOnTurnLimit: true, continueQuestionTimeoutMinutes: 1,
  };
  const rt: RunRuntime = {
    runId: "r1", projectId: "p", host, clock: { now: () => 0, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
    ids: { next: (p) => `${p}-1` }, bus: { emit: () => {} },
    config: { roles: [role()], agents: [agent], channels: [], settings, skills: [], errors: [] } as unknown as Config,
    stateDir: "/st", channelFor: () => channel,
    ledger: new RunLedger(host, "l.jsonl", { now: () => 0, setTimeout: (f, m) => { const t = setTimeout(f, m); return { cancel: () => clearTimeout(t) }; } }),
    leases: new LeaseManager(), idem: undefined as never, cost: { accrued: 0 } as never,
    signal: new AbortController().signal, startedAt: 0, leaseWaitMs: 10, skillBudgetTokens: 100,
    maxNestedDispatches: 1, maxReplans: 1, maxRunHours: 0, planGate: false,
    approve: async () => ({ kind: "approved" }),
    prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("continue") }),
    recoveryService: undefined as never,
    ...over,
  };
  host.log = (l: string) => logged.push(l);
  return { rt, files, logged, host, channel };
}

const okRes: TaskResult = { status: "done", summary: "fine", filesTouched: [] };
const fault = (f: string, over: Partial<TaskResult> = {}): TaskResult => ({ status: "failed", summary: "bad", filesTouched: [], fault: f as never, ...over });

describe("ensureRecovery / logRecovery / SIZE_HINT", () => {
  it("lazily attaches state and prefixes log lines", () => {
    const { rt, logged } = mkRt();
    const a = ensureRecovery(rt);
    expect(a.maxContinuations).toBe(2);
    expect(ensureRecovery(rt)).toBe(a);
    logRecovery(rt, "hello");
    expect(logged[0]).toBe("[run r1] hello");
    expect(SIZE_HINT).toContain("half as much");
  });
});

describe("recoveryBrain", () => {
  it("returns the orchestrator's bound channel+agent, undefined when absent or unhealthy", () => {
    const { rt } = mkRt();
    (rt.config.roles as RoleDef[]).push({ ...role(), id: "orchestrator", agent: "a" });
    expect(recoveryBrain(rt)?.agent.id).toBe("a");
    const { rt: rt2 } = mkRt();
    expect(recoveryBrain(rt2)).toBeUndefined();
    const { rt: rt3 } = mkRt();
    rt3.channelFor = () => ({ unhealthy: true }) as never;
    (rt3.config.roles as RoleDef[]).push({ ...role(), id: "orchestrator", agent: "a" });
    expect(recoveryBrain(rt3)).toBeUndefined();
  });
});

describe("recoverable layers", () => {
  const run = (resSeq: TaskResult[], rt: RunRuntime, r = role(), ctx = { depth: 0 }) => {
    let i = 0;
    const calls: { history?: ChatMessage[]; idemOffset?: number; extra?: string }[] = [];
    const rec = createRecovery(async (_rt, _s, deps) => {
      calls.push({ history: deps.history, idemOffset: deps.idemOffset, extra: deps.extraBriefing });
      return resSeq[Math.min(i++, resSeq.length - 1)];
    });
    return { rec, calls, done: rec.runTask(rt, spec, { role: r }, ctx) };
  };

  it("passes a clean result straight through", async () => {
    const { rt } = mkRt();
    const { done, calls } = run([okRes], rt);
    expect(await done).toBe(okRes);
    expect(calls).toHaveLength(1);
  });

  it("returns cancelled when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { rt } = mkRt({ signal: ac.signal });
    const { done, calls } = run([okRes], rt);
    expect((await done).status).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("retries incomplete_stream once", async () => {
    const { rt, logged } = mkRt();
    const { done, calls } = run([fault("incomplete_stream"), okRes], rt);
    expect((await done).status).toBe("done");
    expect(calls).toHaveLength(2);
    expect(logged.some((l) => l.includes("incomplete_stream"))).toBe(true);
  });

  it("retries a non-writer once with the size hint, then returns the result", async () => {
    const { rt } = mkRt();
    const { done, calls } = run([fault("truncated"), fault("truncated")], rt, { ...role(["ReadFile"]), id: "code-reviewer" });
    await done;
    expect(calls).toHaveLength(2);
    expect(calls[1].extra).toContain("half as much");
  });

  it("spends the single layer-0 retry on incomplete_stream, then returns a non-writer's truncated fault", async () => {
    const { rt } = mkRt();
    const { done, calls } = run([fault("incomplete_stream"), fault("truncated")], rt, { ...role(["ReadFile"]), id: "code-reviewer" });
    const res = await done;
    expect(res.fault).toBe("truncated");
    expect(calls).toHaveLength(2);
    expect(ensureRecovery(rt).recoveriesUsed).toBe(1);
  });

  it("asks on turn_limit and continues with transcript + idem offset", async () => {
    const { rt } = mkRt();
    const transcript: ChatMessage[] = [{ role: "user", content: "u" }, { role: "assistant", content: "a", toolCalls: [{ id: "1", name: "T", arguments: {} }] }];
    const { done, calls } = run([fault("turn_limit", { transcript, turnBudget: 5 }), okRes], rt);
    expect((await done).status).toBe("done");
    expect(calls[1].history).toHaveLength(2);
    expect(calls[1].idemOffset).toBe(1);
  });

  it("stops when the user declines continuation", async () => {
    const { rt } = mkRt({ prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Stop") }) });
    const { done } = run([fault("turn_limit", { transcript: [] })], rt);
    const res = await done;
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("stopped by user");
  });

  it("returns the fault when no recoveries remain", async () => {
    const { rt } = mkRt();
    rt.recovery = ensureRecovery(rt);
    rt.recovery!.recoveriesUsed = 99;
    const { done } = run([fault("incomplete_stream")], rt);
    expect((await done).fault).toBe("incomplete_stream");
  });
});

describe("splitTask", () => {
  const brain = (planArgs?: unknown): { channel: ManagedChannel; agent: AgentDef } => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {
        yield { kind: "text", text: '<tool_call>{"name":"submit_recovery","arguments":' + JSON.stringify(planArgs ?? { subtasks: [{ description: "a", output_file: "o1.txt" }, { description: "b", output_file: "o2.txt" }] }) + "}</tool_call>" } as ChatEvent;
        yield { kind: "done" } as ChatEvent;
      },
    };
    return { channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }), agent };
  };

  it("splits, runs sub-tasks under the scratch gate and returns done", async () => {
    const { rt, files } = mkRt();
    const R = ensureRecovery(rt);
    const parent: TaskResult = { ...fault("turn_limit"), transcript: [] };
    const res = await splitTask(rt, spec, role(), parent, { depth: 0, brain: brain(), recurse: async (_r, s, _d, _c) => {
      files[`.stewart/scratch/r1/task-t1/${s.id.endsWith("s1") ? "o1.txt" : "o2.txt"}`] = "out-" + s.id;
      return { status: "done", summary: "sub done", filesTouched: [] };
    } }, R);
    expect(res.status).toBe("done");
    expect(res.summary).toContain("split into 2");
  });

  it("fails when the planner returns no valid plan", async () => {
    const { rt } = mkRt();
    const R = ensureRecovery(rt);
    const bad = brain({ nope: 1 });
    const res = await splitTask(rt, spec, role(), { ...fault("truncated"), transcript: [] }, { depth: 0, brain: bad, recurse: async () => okRes }, R);
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("no valid submit_recovery");
  });

  it("stops at the first failing sub-task", async () => {
    const { rt } = mkRt();
    const R = ensureRecovery(rt);
    let n = 0;
    const res = await splitTask(rt, spec, role(), { ...fault("turn_limit"), transcript: [] }, { depth: 0, brain: brain(), recurse: async () => (n++, { status: "failed", summary: "sub broke", filesTouched: [] }) }, R);
    expect(res.status).toBe("failed");
    expect(n).toBe(1);
    expect(res.summary).toContain("sub-task failed");
  });
});

describe("assembleFinalFile", () => {
  const plan: RecoveryPlan = { subtasks: [{ description: "a", outputFile: "o1.txt" }, { description: "b", outputFile: "o2.txt" }], finalFile: "out/merged.txt" };

  it("joins sub-task outputs through the approval path", async () => {
    const { rt, files } = mkRt();
    const dir = ".stewart/scratch/r1/task-t1";
    files[`${dir}/o1.txt`] = "one";
    files[`${dir}/o2.txt`] = "two";
    const res = await assembleFinalFile(rt, spec, role(), plan, dir);
    expect(res).toEqual({ ok: true, rel: "out/merged.txt" });
    expect(files["out/merged.txt"]).toBe("one\ntwo");
  });

  it("reports rejected writes, missing outputs and bad paths", async () => {
    const { rt, files } = mkRt();
    const dir = ".stewart/scratch/r1/task-t1";
    files[`${dir}/o1.txt`] = "one";
    files[`${dir}/o2.txt`] = "two";
    const rejected = await assembleFinalFile({ ...rt, approve: async () => ({ kind: "rejected", reason: "no" }) }, spec, role(), plan, dir);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("rejected");
    delete files[`${dir}/o2.txt`];
    expect((await assembleFinalFile(rt, spec, role(), plan, dir)).error).toContain("cannot read");
    expect((await assembleFinalFile(rt, spec, role(), { ...plan, finalFile: "../evil" }, dir)).error).toContain("rejected");
    expect((await assembleFinalFile(rt, spec, role(), { subtasks: [], finalFile: undefined }, dir)).ok).toBe(true);
  });
});

describe("submitRecoveryTool", () => {
  it("returns the default message without a callback", async () => {
    const t = submitRecoveryTool();
    expect(t.coreHandled).toBe(true);
    expect(await t.execute({}, null, new AbortController().signal)).toContain("Recovery plan recorded");
  });
});

describe("recoverable turn-limit branches", () => {
  const run = (rt: RunRuntime, resSeq: TaskResult[], ctx = { depth: 0, brain: { channel: undefined as never, agent: { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef } }) => {
    let i = 0;
    const rec = createRecovery(async () => resSeq[Math.min(i++, resSeq.length - 1)]);
    return rec.runTask(rt, spec, { role: role() }, ctx as never);
  };

  it("skips the question when askOnTurnLimit is off", async () => {
    const { rt } = mkRt();
    rt.config.settings.askOnTurnLimit = false;
    rt.recovery = undefined;
    const res = await run(rt, [fault("turn_limit", { transcript: [] })], { depth: 0 });
    expect(res.fault).toBe("turn_limit");
  });

  it("treats an askTimed timeout like a decline", async () => {
    const { rt } = mkRt({ prompt: async () => ({ kind: "withdrawn" as const, reason: "timeout" as const }) });
    const res = await run(rt, [fault("turn_limit", { transcript: [] })], { depth: 0 });
    expect(res.fault).toBe("turn_limit");
  });

  it("appends guidance text to the continuation history", async () => {
    const { rt } = mkRt({ prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("focus on part one") }) });
    const seen: (ChatMessage[] | undefined)[] = [];
    let i = 0;
    const rec = createRecovery(async (_r, _s, deps) => {
      seen.push(deps.history);
      return [fault("turn_limit", { transcript: [{ role: "user", content: "u" }] }), okRes][Math.min(i++, 1)];
    });
    const res = await rec.runTask(rt, spec, { role: role() }, { depth: 0 });
    expect(res.status).toBe("done");
    expect(seen[1]?.at(-1)).toEqual({ role: "user", content: "focus on part one" });
  });

  it("split answer falls through to layer 1 and returns its result", async () => {
    const { rt } = mkRt({ prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Split it") }) });
    const brain = { channel: new ManagedChannel({ type: "fake", listModels: async () => [], probeCaps: async () => ({}), chat: async function* () {
      yield { kind: "text", text: '<tool_call>{"name":"submit_recovery","arguments":{"subtasks":[{"description":"a","output_file":"o1"},{"description":"b","output_file":"o2"}]}}</tool_call>' } as ChatEvent;
      yield { kind: "done" } as ChatEvent;
    } }, { id: "c", type: "fake", enabled: true, maxParallel: 1 }), agent };
    let n = 0;
    const rec = createRecovery(async () => (n++, n === 1 ? fault("turn_limit", { transcript: [] }) : okRes));
    const res = await rec.runTask(rt, spec, { role: role() }, { depth: 0, brain });
    expect(res.status).toBe("done");
    expect(res.summary).toContain("split into");
  });

  it("turn_limit timeout falls through to layer-1 split, and returns the fault without a brain", async () => {
    const timeoutPrompt = async () => ({ kind: "withdrawn" as const, reason: "timeout" as const });
    const brain = { channel: new ManagedChannel({ type: "fake", listModels: async () => [], probeCaps: async () => ({}), chat: async function* () {
      yield { kind: "text", text: '<tool_call>{"name":"submit_recovery","arguments":{"subtasks":[{"description":"a","output_file":"o1"},{"description":"b","output_file":"o2"}]}}</tool_call>' } as ChatEvent;
      yield { kind: "done" } as ChatEvent;
    } }, { id: "c", type: "fake", enabled: true, maxParallel: 1 }), agent };
    const { rt } = mkRt({ prompt: timeoutPrompt });
    let n = 0;
    const rec = createRecovery(async () => (n++, n === 1 ? fault("turn_limit", { transcript: [] }) : okRes));
    const res = await rec.runTask(rt, spec, { role: role() }, { depth: 0, brain });
    expect(res.status).toBe("done");
    expect(res.summary).toContain("split into");
    expect(ensureRecovery(rt).questionsUsed).toBe(1);

    const { rt: rtNoBrain } = mkRt({ prompt: timeoutPrompt });
    const res2 = await run(rtNoBrain, [fault("turn_limit", { transcript: [] })], { depth: 0 });
    expect(res2.fault).toBe("turn_limit");
    expect(ensureRecovery(rtNoBrain).questionsUsed).toBe(1);
  });
});

import { parseRecoveryArgs as parseArgs } from "../src/api.js";

describe("parseRecoveryArgs extra branches", () => {
  const lim = { maxSubTasks: 4, ceiling: 60 };
  it("rejects non-object subtasks, bad final_file and counts advice", () => {
    const { parseRecoveryArgs } = { parseRecoveryArgs: null as never };
    void parseRecoveryArgs;
    expect(() => submitRecoveryTool).not.toThrow();
    const p1 = { subtasks: [5, { description: "b", output_file: "o" }] };
    expect(() => parseArgs(p1, lim)).toThrow("not an object");
    const p2 = { subtasks: [{ description: "a", output_file: "o1" }, { description: "b", output_file: "o2" }], final_file: 5 };
    expect(() => parseArgs(p2, lim)).toThrow("final_file");
    const p3 = { subtasks: [{ description: "a", output_file: "o1" }, { description: "b", output_file: "o2" }], advice: 9 };
    expect(parseArgs(p3, lim).advice).toBeUndefined();
    const p4 = { subtasks: [{ description: " ", output_file: "o1" }, { description: "b", output_file: "o2" }] };
    expect(() => parseArgs(p4, lim)).toThrow("description");
    const p5 = { subtasks: [{ description: "a", output_file: "o1" }, { description: "b", output_file: "o2", max_turns: 2.5 }] };
    expect(() => parseArgs(p5, lim)).toThrow("max_turns");
  });
});

describe("continueQuestion as Prompt", () => {
  it("returns a continue-topic prompt with the timeout that decodes to a ContinueChoice", () => {
    const p = continueQuestion({ spec, turns: 5, transcript: [], maxActions: 3, canSplit: true, timeoutMs: 1234 });
    expect(p.kind).toBe("question");
    if (p.kind === "question") {
      expect(p.topic).toBe("continue");
      expect(p.timeoutMs).toBe(1234);
      expect(p.options[0]).toContain("Continue (+5 turns)");
      expect(p.decode("Split into smaller tasks")).toEqual({ kind: "split" });
      expect(p.decode("Continue (+5 turns)")).toEqual({ kind: "continue" });
      expect(p.decode("look in utils.ts")).toEqual({ kind: "text", text: "look in utils.ts" });
    }
  });
});
