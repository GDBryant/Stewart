import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "../src/channels/types.js";
import { ManagedChannel } from "../src/channels/registry.js";
import { EventBus } from "../src/events.js";
import { loadConfig, type Config } from "../src/config/loader.js";
import { systemClock } from "../src/ports.js";
import { createAgentSession, type SessionSpec } from "../src/agentSession.js";
import { RunLedger, CostLimit } from "../src/orchestration/ledger.js";
import { DEFAULT_BUDGET_PROFILES, DEFAULT_LIMITS } from "@stewart/budget";
import { type ApprovalDecision } from "../src/tools/toolLoop.js";
import { ToolRegistry, type Tool } from "../src/tools/types.js";
import { fakeHost } from "./helpers.js";
import type { RunEvent } from "@stewart/protocol";

const done = (usage?: { in: number; out: number }, costUsd?: number): ChatEvent => ({ kind: "done", usage, costUsd });
const text = (t: string): ChatEvent => ({ kind: "text", text: t });
const calls = (...c: { id: string; name: string; arguments: Record<string, unknown> }[]): ChatEvent => ({ kind: "tool_calls", calls: c });

/** Call 1 requests the `echo` tool, call 2 answers with text. */
function fakeChannel(): ManagedChannel {
  let n = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    async *chat(_cfg, _secret, _req: ChatRequest) {
      n += 1;
      if (n === 1) {
        yield text("reading");
        yield calls({ id: "c1", name: "echo", arguments: { path: "a.ts" } });
        yield done({ in: 1000, out: 500 });
      } else {
        yield text("all done");
        yield done({ in: 1000, out: 500 });
      }
    },
  };
  const cfg = { id: "c1", type: "fake", enabled: true, maxParallel: 4, modelCaps: { m: { tools: "native" as const } } };
  return new ManagedChannel(adapter, cfg);
}

const CHANNELS = "version: 1\nitems:\n  - id: c1\n    type: fake\n    modelCaps:\n      m:\n        tools: native\n";
const AGENTS = `version: 1
items:
  - id: a-paid
    channel: c1
    model: m
    billing: reported
  - id: a-priced
    channel: c1
    model: m
    billing: priced
    price: { inPerMTok: 3, outPerMTok: 15 }
`;

function config(): Config {
  return loadConfig({ "channels.yaml": CHANNELS, "agents.yaml": AGENTS }, {}, {}, true);
}

const echo: Tool = {
  spec: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  async execute() {
    return "ok";
  },
};

const approve = async (): Promise<ApprovalDecision> => ({ kind: "approved" });

function harness(agentId: string) {
  const cfg = config();
  const agent = cfg.agents.find((a) => a.id === agentId)!;
  const events: RunEvent[] = [];
  const bus = new EventBus((e) => events.push(e), 0);
  const fake = fakeHost({});
  const ledger = new RunLedger(fake.host, "/tmp/st/ledger.jsonl", systemClock);
  const cost = new CostLimit(cfg.settings.costLimit.perRunUsd, cfg.settings.costLimit.onLimit);
  const spec: SessionSpec = {
    agent,
    channel: fakeChannel(),
    registry: new ToolRegistry([echo]),
    approve,
  };
  return { spec, events, bus, ledger, cost };
}

async function flush(bus: EventBus): Promise<void> {
  bus.flush();
  await new Promise((r) => setTimeout(r, 5));
}

const RUN = (session: ReturnType<typeof createAgentSession>) =>
  session.loop.run("m", [{ role: "user", content: "go" }], session.listener, new AbortController().signal);

describe("createAgentSession", () => {
  it("emits text, tool request and outcome events in order with run/task/role ids", async () => {
    const h = harness("a-paid");
    h.spec.events = { bus: h.bus, runId: "run-1", taskId: "t1", roleId: "code-writer" };
    const session = createAgentSession(h.spec, systemClock);
    await RUN(session);
    await flush(h.bus);
    expect(h.events.map((e) => e.kind)).toEqual(["text_delta", "tool.request", "tool.outcome", "text_delta"]);
    for (const e of h.events) expect(e).toMatchObject({ runId: "run-1", taskId: "t1", roleId: "code-writer" });
    expect(h.events[1]).toMatchObject({ kind: "tool.request", callId: "c1", tool: "echo" });
    expect(h.events[2]).toMatchObject({ kind: "tool.outcome", callId: "c1", ok: true });
  });

  it("records ledger entries with role/task ids and accrues cost for a priced agent", async () => {
    const h = harness("a-priced");
    h.spec.meter = { ledger: h.ledger, cost: h.cost, runId: "run-1", taskId: "t1", roleId: "code-writer" };
    await h.ledger.load();
    const session = createAgentSession(h.spec, systemClock);
    await RUN(session);
    const entries = h.ledger.entriesFor("run-1");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatchObject({ runId: "run-1", taskId: "t1", roleId: "code-writer", agentId: "a-priced" });
    const total = entries.reduce((s, e) => s + e.costUsd, 0);
    expect(total).toBeGreaterThan(0);
    expect(h.cost.accrued).toBeCloseTo(total, 10);
  });

  it("calls hooks.onToolRequested with the requested call", async () => {
    const h = harness("a-paid");
    const seen: string[] = [];
    h.spec.hooks = { onToolRequested: (call) => void seen.push(`${call.id}:${call.name}`) };
    const session = createAgentSession(h.spec, systemClock);
    await RUN(session);
    expect(seen).toEqual(["c1:echo"]);
  });

  it("negative: without meter there is no onUsage listener and no ledger entry", async () => {
    const h = harness("a-priced");
    await h.ledger.load();
    const session = createAgentSession(h.spec, systemClock);
    expect(session.listener.onUsage).toBeUndefined();
    await RUN(session);
    expect(h.ledger.entriesFor("run-1")).toEqual([]);
    expect(h.cost.accrued).toBe(0);
  });

  it("negative: without events nothing is emitted on the bus", async () => {
    const h = harness("a-paid");
    const session = createAgentSession(h.spec, systemClock);
    await RUN(session);
    await flush(h.bus);
    expect(h.events).toEqual([]);
  });

  it("negative: limitsOverride.maxModelTurns above the resolved budget is clamped", () => {
    const h = harness("a-paid");
    const budget = { profile: DEFAULT_BUDGET_PROFILES.normal, ceiling: 60 };
    const resolved = createAgentSession({ ...h.spec, budget }, systemClock).limits.maxModelTurns;
    const clamped = createAgentSession({ ...h.spec, budget, limitsOverride: { maxModelTurns: resolved + 1000 } }, systemClock);
    expect(clamped.limits.maxModelTurns).toBe(resolved);
    const lower = createAgentSession({ ...h.spec, budget, limitsOverride: { maxModelTurns: 1 } }, systemClock);
    expect(lower.limits.maxModelTurns).toBe(1);
  });

  it("without budget, limitsOverride applies over DEFAULT_LIMITS", () => {
    const h = harness("a-paid");
    const plain = createAgentSession(h.spec, systemClock);
    expect(plain.limits).toEqual(DEFAULT_LIMITS);
    const over = createAgentSession({ ...h.spec, limitsOverride: { maxModelTurns: 3 } }, systemClock);
    expect(over.limits.maxModelTurns).toBe(3);
    expect(over.limits.maxModelTurns).not.toBe(DEFAULT_LIMITS.maxModelTurns);
    expect({ ...over.limits, maxModelTurns: DEFAULT_LIMITS.maxModelTurns }).toEqual(DEFAULT_LIMITS);
  });

  it("emits compaction with before/after/pruned/summarized when detail is given, bare otherwise", async () => {
    const h = harness("a-paid");
    h.spec.events = { bus: h.bus, runId: "run-1" };
    const session = createAgentSession(h.spec, systemClock);
    session.listener.onCompacted?.(100, 40, { pruned: 2, summarized: true });
    session.listener.onCompacted?.(50, 60);
    await flush(h.bus);
    const c = h.events.filter((e) => e.kind === "compaction");
    expect(c[0]).toMatchObject({ droppedTokens: 60, beforeTokens: 100, afterTokens: 40, pruned: 2, summarized: true });
    expect(c[1]).toMatchObject({ droppedTokens: 0 });
    expect(c[1]).not.toHaveProperty("pruned");
  });
});
