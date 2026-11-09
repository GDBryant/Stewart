import { describe, expect, it, vi } from "vitest";
import { Core } from "../src/core.js";
import { fakeHost } from "@stewart/kernel";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import type { RunEvent } from "@stewart/protocol";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
    delete: async (file) => {
      delete layer[file];
    },
  };
}

const adapter: ChannelAdapter = {
  type: "fake",
  listModels: async () => ["m1"],
  probeCaps: async () => ({ tools: true }),
  chat: async function* () {
    yield { kind: "text", text: "hi" } as ChatEvent;
    yield { kind: "done", usage: { in: 1, out: 1 } } as ChatEvent;
  },
};

const CHANNELS =
  "version: 1\nitems:\n  - id: c1\n    type: fake\n    enabled: true\n    secretRef: sec1\n";
const AGENTS = "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n";
const ROLES = "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n    tools: []\n";
const AGENTS_A9 = "version: 1\nitems:\n  - id: a9\n    channel: c1\n    model: m1\n";

function mk(userLayer: ConfigLayer = {}) {
  const user = memStore(userLayer);
  const uLayer = userLayer;
  const events: RunEvent[] = [];
  const secretDeleted: string[] = [];
  const fh = fakeHost();
  fh.host.secrets = {
    get: async (k) => (k === "sec1" ? "s3cr3t" : undefined),
    set: async () => {},
    delete: async (k) => {
      secretDeleted.push(k);
    },
  };
  const core = new Core({
    defaults: { "channels.yaml": CHANNELS, "agents.yaml": AGENTS, "roles.yaml": ROLES },
    userConfig: user,
    projectConfig: async () => memStore(),
    fetcher: async () => {
      throw new Error("no fetch");
    },
    emitEvent: (e) => events.push(e),
  });
  core.channels.register("fake", () => adapter);
  return { core, uLayer, events, fh, secretDeleted };
}

type Sess = { phase: string; draft: Record<string, any> };
const sess = (r: unknown) => r as Sess;
const phaseOf = async (core: Core, pid: string) => sess(await core.dispatch("setup.session.get", { projectId: pid })).phase;

describe("setup.session via dispatch", () => {
  it("start/get/update expose phase and draft; get returns the same session", async () => {
    const { core, fh } = mk();
    const pid = "w1";
    await core.attachProject(pid, fh.host);
    const s = sess(await core.dispatch("setup.session.start", { projectId: pid }));
    expect(s.phase).toBe("channels");
    expect(s.draft.phase).toBe("channels");
    const g1 = sess(await core.dispatch("setup.session.get", { projectId: pid }));
    expect(g1.draft.createdAt).toBe(s.draft.createdAt);

    const u = sess(
      await core.dispatch("setup.session.update", {
        projectId: pid,
        patch: { channels: [{ id: "c1", tested: "ok", models: ["m1"] }], reusedChannels: ["old"] },
      }),
    );
    expect(u.draft.channels).toEqual([{ id: "c1", tested: "ok", models: ["m1"] }]);
    expect(u.draft.reusedChannels).toEqual(["old"]);

    const g2 = sess(await core.dispatch("setup.session.get", { projectId: pid }));
    expect(g2.draft.channels).toHaveLength(1);
    expect(g2.draft.createdAt).toBe(s.draft.createdAt);
  });

  it("advance enforces gates phase by phase and back moves freely", async () => {
    const { core, fh } = mk();
    const pid = "w2";
    await core.attachProject(pid, fh.host);
    const adv = async () => (await core.dispatch("setup.session.advance", { projectId: pid })) as { ok: boolean; error?: string };
    const back = async () => (await core.dispatch("setup.session.back", { projectId: pid })) as { ok: boolean };
    await core.dispatch("setup.session.start", { projectId: pid });
    expect(await phaseOf(core, pid)).toBe("channels");

    let r = await adv();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("tested OK");

    await core.dispatch("setup.session.update", { projectId: pid, patch: { channels: [{ id: "c1", tested: "ok", models: ["m1"] }] } });
    r = await adv();
    expect(r).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("evaluator");

    r = await adv();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("evaluator");

    await core.dispatch("setup.session.update", { projectId: pid, patch: { evaluator: "rules" } });
    expect(await adv()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("evaluate");

    await core.dispatch("setup.session.update", {
      projectId: pid,
      patch: { evaluation: { done: 1, total: 1, tally: { evaluated: 1, unavailable: 0, skipped: 0 }, results: { m1: {} }, finished: true } },
    });
    expect(await adv()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("assign");

    r = await adv();
    expect(r.ok).toBe(false);

    await core.dispatch("setup.session.update", { projectId: pid, patch: { assignment: { "general-worker": "a1" }, assignmentValid: true } });
    expect(await adv()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("approve");

    r = await adv();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("review");

    expect(await back()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("assign");
    expect(await back()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("evaluate");
    expect(await back()).toEqual({ ok: true });
    expect(await back()).toEqual({ ok: true });
    expect(await phaseOf(core, pid)).toBe("channels");
    expect(await back()).toEqual({ ok: false });
  });

  it("review returns a token; approve rejects a wrong token without reload and saves with the real one", async () => {
    const { core, uLayer, events, fh } = mk();
    const pid = "w3";
    await core.attachProject(pid, fh.host);
    const reloadSpy = vi.spyOn(core, "reload");
    await core.dispatch("setup.session.start", { projectId: pid });
    await core.dispatch("setup.session.update", {
      projectId: pid,
      patch: { files: { "agents.yaml": AGENTS_A9, "settings.yaml": "version: 1\n" } },
    });
    const rev = (await core.dispatch("setup.review", { projectId: pid })) as { token: string; files: Record<string, string>; base: Record<string, string | undefined> };
    expect(typeof rev.token).toBe("string");
    expect(rev.files["agents.yaml"]).toContain("a9");
    expect(rev.base).toBeTypeOf("object");

    const bad = (await core.dispatch("setup.approve", { projectId: pid, token: "bogus" })) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("stale_approval");
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(uLayer["agents.yaml"]).toBeUndefined();

    const good = (await core.dispatch("setup.approve", { projectId: pid, token: rev.token })) as { ok: boolean; error?: string };
    expect(good.ok).toBe(true);
    expect(reloadSpy).toHaveBeenCalledWith(pid);
    expect(uLayer["agents.yaml"]).toContain("a9");
    expect(uLayer["settings.yaml"]).toBe("version: 1\n");
    expect(
      events.some(
        (e) =>
          e.kind === "setup.event" &&
          (e as { event?: { kind?: string; phase?: string } }).event?.kind === "phase" &&
          (e as { event?: { phase?: string } }).event?.phase === "saved",
      ),
    ).toBe(true);
  });

  it("surfaces validateFiles errors through approve", async () => {
    const { core, uLayer, fh } = mk();
    const pid = "w4";
    await core.attachProject(pid, fh.host);
    await core.dispatch("setup.session.start", { projectId: pid });
    const cases: [Record<string, string>, RegExp][] = [
      [{ "bogus.yaml": "version: 1\n" }, /unknown config file: bogus\.yaml/],
      [{ "channels.yaml": "version: 1\nitems: [\n" }, /invalid YAML/],
      [{ "channels.yaml": "version: 1\nitems: 5\n" }, /^channels\.yaml:/],
    ];
    for (const [files, re] of cases) {
      await core.dispatch("setup.session.update", { projectId: pid, patch: { files } });
      const rev = (await core.dispatch("setup.review", { projectId: pid })) as { token: string };
      const res = (await core.dispatch("setup.approve", { projectId: pid, token: rev.token })) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(re);
    }
    expect(uLayer["channels.yaml"]).toBeUndefined();
    expect(uLayer["bogus.yaml"]).toBeUndefined();
  });

  it("approve then undo restores the previous user files", async () => {
    const { core, uLayer, fh } = mk({ "channels.yaml": "version: 1\nitems: []\n" });
    const pid = "w5";
    await core.attachProject(pid, fh.host);
    await core.dispatch("setup.session.start", { projectId: pid });
    await core.dispatch("setup.session.update", {
      projectId: pid,
      patch: { files: { "channels.yaml": "version: 1\nitems:\n  - id: c9\n    type: fake\n    enabled: true\n" } },
    });
    const rev = (await core.dispatch("setup.review", { projectId: pid })) as { token: string };
    const app = (await core.dispatch("setup.approve", { projectId: pid, token: rev.token })) as { ok: boolean };
    expect(app.ok).toBe(true);
    expect(uLayer["channels.yaml"]).toContain("c9");
    const un = (await core.dispatch("setup.undo", { projectId: pid })) as { ok: boolean; error?: string };
    expect(un.ok).toBe(true);
    expect(uLayer["channels.yaml"]).toBe("version: 1\nitems: []\n");
  });

  it("undo reports no backup on a fresh project", async () => {
    const { core, fh } = mk();
    const pid = "w6";
    await core.attachProject(pid, fh.host);
    const res = (await core.dispatch("setup.undo", { projectId: pid })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no backup");
  });

  it("cancel deletes session-created secrets and the next start is a fresh session", async () => {
    const { core, fh, secretDeleted } = mk();
    const setSecret = vi.spyOn(core.channelService, "setSecret");
    const pid = "w7";
    await core.attachProject(pid, fh.host);
    expect(core.secretValues.has("sec1")).toBe(true);
    await core.dispatch("setup.session.start", { projectId: pid });
    await core.dispatch("setup.session.update", { projectId: pid, patch: { secretsCreated: ["sec1"] } });
    const c = (await core.dispatch("setup.session.cancel", { projectId: pid })) as { ok: boolean };
    expect(c.ok).toBe(true);
    expect(secretDeleted).toContain("sec1");
    expect(setSecret).toHaveBeenCalledWith("sec1", undefined);
    expect(core.secretValues.has("sec1")).toBe(false);
    const s = sess(await core.dispatch("setup.session.start", { projectId: pid }));
    expect(s.phase).toBe("channels");
    expect(s.draft.secretsCreated).toEqual([]);
  });
});
