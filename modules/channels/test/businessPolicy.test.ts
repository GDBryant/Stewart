import type { ChatMessage } from "@stewart/kernel";
import { describe, expect, it } from "vitest";
import { BusinessPolicyError, ChannelRegistry, rulesFor, type ChannelAdapter, type ChannelSpec, type ChatRequest } from "../src/api.js";
import { ChannelService } from "../src/service.js";

const SECRET = "password=hunter2";

function setup() {
  const sent: ChatRequest[] = [];
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      sent.push(req);
      yield { kind: "done" };
    },
  };
  const registry = new ChannelRegistry();
  registry.register("fake", () => adapter);
  const svc = new ChannelService({ registry, adapterDeps: {} });
  const host = { secrets: { get: async () => undefined }, log: () => {} };
  return { svc, host, sent };
}

const spec = (id: string, over: Partial<ChannelSpec> = {}): ChannelSpec => ({ id, type: "fake", enabled: true, ...over });
const run = async (it: AsyncIterable<unknown>) => {
  for await (const _ of it) void _;
};
const req = (messages: ChatMessage[], extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages, signal: new AbortController().signal, ...extra });

describe("rulesFor", () => {
  it("defaults to every rule on", () => {
    expect(rulesFor(spec("a"))).toEqual(["passwords", "privacy"]);
  });
  it("channel override wins per rule, otherwise the global value applies", () => {
    const g = { passwords: true, privacy: false };
    expect(rulesFor(spec("a"), g)).toEqual(["passwords"]);
    expect(rulesFor(spec("a", { security: { privacy: true } }), g)).toEqual(["passwords", "privacy"]);
    expect(rulesFor(spec("a", { security: { passwords: false } }), g)).toEqual([]);
  });
});

describe("ManagedChannel business policy", () => {
  it("blocks user content: nothing is sent, slot not held, breaker untouched", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a", { maxParallel: 1 })], host);
    const ch = svc.require("a");
    for (let i = 0; i < 6; i++) await expect(run(ch.chat(req([{ role: "user", content: SECRET }])))).rejects.toBeInstanceOf(BusinessPolicyError);
    expect(sent).toHaveLength(0);
    expect(ch.health).toBe("healthy");
    await run(ch.chat(req([{ role: "user", content: "hi" }]))); // the single slot is still free
    expect(sent).toHaveLength(1);
  });

  it("error carries evidence without the secret", async () => {
    const { svc, host } = setup();
    await svc.rebuild([spec("a")], host);
    const e = await run(svc.require("a").chat(req([{ role: "user", content: SECRET }]))).catch((x: unknown) => x as BusinessPolicyError);
    expect(e.message).toBe("business_policy: blocked outgoing message to a: passwords in user #0 (secret assignment)");
    expect(e.message).not.toContain("hunter2");
    expect(e.violations[0]?.rule).toBe("passwords");
  });

  it("withholds a tool result in the sent copy only and reports it", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a")], host);
    const messages: ChatMessage[] = [{ role: "user", content: "read it" }, { role: "tool", toolCallId: "t", content: SECRET }];
    const seen: string[] = [];
    await run(svc.require("a").chat(req(messages, { onWithheld: (w) => seen.push(...w.map((v) => v.rule)) })));
    expect(seen).toEqual(["passwords"]);
    expect(sent[0]?.messages[1]).toEqual({ role: "tool", toolCallId: "t", content: "[output withheld by business policy: passwords]" });
    expect(messages[1]).toMatchObject({ content: SECRET });
  });

  it("withholds without a callback too", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a")], host);
    await run(svc.require("a").chat(req([{ role: "tool", toolCallId: "t", content: SECRET }])));
    expect(sent[0]?.messages[0]?.content).toMatch(/withheld/);
  });

  it("sends clean text unchanged", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a")], host);
    const m: ChatMessage[] = [{ role: "user", content: "hello" }];
    await run(svc.require("a").chat(req(m)));
    expect(sent[0]?.messages).toEqual(m);
  });

  it("a channel with the rule off sends the secret", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a", { security: { passwords: false } }), spec("b")], host);
    await run(svc.require("a").chat(req([{ role: "user", content: SECRET }])));
    expect(sent).toHaveLength(1);
    await expect(run(svc.require("b").chat(req([{ role: "user", content: SECRET }])))).rejects.toThrow(/business_policy/);
  });

  it("a reload re-applies rules to the surviving channel", async () => {
    const { svc, host, sent } = setup();
    await svc.rebuild([spec("a")], host);
    const ch = svc.require("a");
    await expect(run(ch.chat(req([{ role: "user", content: SECRET }])))).rejects.toThrow();
    await svc.rebuild([spec("a")], host, { passwords: false, privacy: true });
    expect(svc.require("a")).toBe(ch);
    expect(ch.policyRules).toEqual(["privacy"]);
    await run(ch.chat(req([{ role: "user", content: SECRET }])));
    expect(sent).toHaveLength(1);
  });
});
