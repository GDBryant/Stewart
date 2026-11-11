import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeHost } from "@stewart/kernel";
import { SetupSession, type SetupSessionDeps } from "../src/session.js";

const ORIGINAL = "version: 1\nitems:\n  - id: ollama\n    type: ollama\n    enabled: true\n";

function setup(initial: string | null = ORIGINAL, over: Partial<SetupSessionDeps> = {}) {
  const { host, files } = fakeHost();
  const user: Record<string, string | undefined> = { "channels.yaml": initial ?? undefined };
  const secrets = new Map<string, string>();
  const deletedSecrets: string[] = [];
  const deletedFiles: string[] = [];
  const deps: SetupSessionDeps = {
    files: host.files,
    stateDir: "state",
    readUserFiles: async () => ({ ...user }),
    writeUserFile: async (n, y) => void (user[n] = y),
    deleteUserFile: async (n) => {
      deletedFiles.push(n);
      delete user[n];
    },
    setSecret: async (ref, v) => void secrets.set(ref, v),
    deleteSecret: async (ref) => void deletedSecrets.push(ref),
    now: () => 1_000_000,
    ...over,
  };
  return { deps, user, secrets, deletedSecrets, deletedFiles, files };
}
const items = (user: Record<string, string | undefined>) => (parseYaml(user["channels.yaml"] ?? "") as { items: { id: string; [k: string]: unknown }[] }).items;
const staged = { "agents.yaml": "version: 1\nitems: []\n" };

describe("SetupSession.addChannel", () => {
  it("writes the channel ahead of approval, keeps existing channels and records it in the draft", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    expect(await s.addChannel({ id: "aif", type: "openai-compatible", baseUrl: "http://aif/v1" })).toEqual({ ok: true });
    expect(items(t.user).map((i) => i.id)).toEqual(["ollama", "aif"]);
    expect(items(t.user)[1]).toEqual({ id: "aif", type: "openai-compatible", enabled: true, baseUrl: "http://aif/v1" });
    expect(s.state.addedChannels).toEqual(["aif"]);
    expect(s.state.channelsBase).toBe(ORIGINAL);
  });

  it("stores an API key in the secret store under channel-<id>, never in the YAML, and tracks it for cleanup", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" }, "sk-secret");
    expect(t.secrets.get("channel-aif")).toBe("sk-secret");
    expect(t.user["channels.yaml"]).not.toContain("sk-secret");
    expect(items(t.user)[1].secretRef).toBe("channel-aif");
    expect(s.state.secretsCreated).toEqual(["channel-aif"]);
  });

  it("re-adding a channel this session added replaces it instead of duplicating", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible", baseUrl: "http://one" });
    await s.addChannel({ id: "aif", type: "openai-compatible", baseUrl: "http://two" });
    expect(items(t.user).filter((i) => i.id === "aif")).toHaveLength(1);
    expect(items(t.user).find((i) => i.id === "aif")!.baseUrl).toBe("http://two");
    expect(s.state.addedChannels).toEqual(["aif"]);
  });

  it("rejects an empty id or type, an id that already exists, invalid YAML, and a key without secret storage; writes nothing", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    expect(await s.addChannel({ id: "  ", type: "ollama" })).toEqual({ ok: false, error: "channel id is required" });
    expect(await s.addChannel({ id: "x", type: "" })).toEqual({ ok: false, error: "channel type is required" });
    expect(await s.addChannel({ id: "ollama", type: "ollama" })).toEqual({ ok: false, error: "channel 'ollama' already exists" });
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
    expect(s.state.channelsBase).toBeUndefined();

    const bad = setup("items: [unclosed");
    expect((await (await SetupSession.open(bad.deps)).addChannel({ id: "x", type: "ollama" })).ok).toBe(false);
    expect(bad.user["channels.yaml"]).toBe("items: [unclosed");

    const noSecrets = setup(ORIGINAL, { setSecret: undefined });
    expect(await (await SetupSession.open(noSecrets.deps)).addChannel({ id: "x", type: "ollama" }, "key")).toEqual({ ok: false, error: "secret storage is unavailable" });
    expect(noSecrets.user["channels.yaml"]).toBe(ORIGINAL);
  });

  it("refuses an id that exists in the merged config (e.g. a shipped channel) even when the user file lacks it", async () => {
    const t = setup(ORIGINAL, { existingChannelIds: () => ["shipped", "ollama"] });
    const s = await SetupSession.open(t.deps);
    expect(await s.addChannel({ id: "shipped", type: "ollama" })).toEqual({ ok: false, error: "channel 'shipped' already exists" });
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
    expect((await s.addChannel({ id: "fresh", type: "ollama" })).ok).toBe(true);
    expect((await s.addChannel({ id: "fresh", type: "ollama" })).ok).toBe(true);
  });

  it("creates channels.yaml when none exists", async () => {
    const t = setup(null);
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "ollama", type: "ollama" });
    expect(items(t.user).map((i) => i.id)).toEqual(["ollama"]);
    expect(s.state.channelsBase).toBeNull();
  });
});

describe("SetupSession.removeChannel", () => {
  it("removes a channel this session added, its secret and its tested state", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" }, "k");
    await s.update({ channels: [{ id: "aif", tested: "ok", models: ["m"] }] });
    expect(await s.removeChannel("aif")).toEqual({ ok: true });
    expect(items(t.user).map((i) => i.id)).toEqual(["ollama"]);
    expect(t.deletedSecrets).toEqual(["channel-aif"]);
    expect(s.state.addedChannels).toEqual([]);
    expect(s.state.secretsCreated).toEqual([]);
    expect(s.state.channels).toEqual([]);
  });

  it("refuses a channel the session did not add and leaves the file untouched", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    expect(await s.removeChannel("ollama")).toEqual({ ok: false, error: "channel 'ollama' was not added by this setup session" });
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
  });
});

describe("cancel rolls channels back", () => {
  it("restores the original channels.yaml and deletes the secrets the session created", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" }, "k");
    await s.cancel();
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
    expect(t.deletedSecrets).toEqual(["channel-aif"]);
  });

  it("deletes channels.yaml when the session created it", async () => {
    const t = setup(null);
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "ollama", type: "ollama" });
    await s.cancel();
    expect(t.deletedFiles).toEqual(["channels.yaml"]);
    expect(t.user["channels.yaml"]).toBeUndefined();
  });

  it("writes an empty channel list when the file was created and no delete hook exists", async () => {
    const t = setup(null, { deleteUserFile: undefined });
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "ollama", type: "ollama" });
    await s.cancel();
    expect(items(t.user)).toEqual([]);
  });

  it("does not touch channels.yaml when the session added no channel", async () => {
    const t = setup();
    let writes = 0;
    t.deps.writeUserFile = async () => void writes++;
    const s = await SetupSession.open(t.deps);
    await s.cancel();
    expect(writes).toBe(0);
    expect(t.deletedFiles).toEqual([]);
  });
});

describe("review, approve and undo cover the added channels", () => {
  it("review stages channels.yaml with the added channel and reports the original as base; approve writes it and backs up the original", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" });
    await s.update({ files: staged });
    const r = await s.review();
    expect(Object.keys(r.files).sort()).toEqual(["agents.yaml", "channels.yaml"]);
    expect(r.base["channels.yaml"]).toBe(ORIGINAL);
    expect(await s.approveAndSave(r.token)).toEqual({ ok: true });
    expect(items(t.user).map((i) => i.id)).toEqual(["ollama", "aif"]);
    const backups = Object.keys(t.files).filter((k) => k.includes("setup-backups") && k.endsWith("channels.yaml"));
    expect(backups).toHaveLength(1);
    expect(t.files[backups[0]]).toBe(ORIGINAL);
  });

  it("undo restores the original channels.yaml after an approved setup", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" });
    await s.update({ files: staged });
    await s.approveAndSave((await s.review()).token);
    expect(items(t.user).map((i) => i.id)).toContain("aif");
    expect((await s.undo()).ok).toBe(true);
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
  });

  it("without added channels, review does not include channels.yaml", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.update({ files: staged });
    expect(Object.keys((await s.review()).files)).toEqual(["agents.yaml"]);
  });

  it("a channels.yaml edit between review and approve makes the approval stale", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" });
    await s.update({ files: staged });
    const r = await s.review();
    await s.addChannel({ id: "other", type: "ollama" });
    expect(await s.approveAndSave(r.token)).toEqual({ ok: false, error: "stale_approval" });
  });

  it("a failed write restores the files as they were, channels included", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" });
    await s.update({ files: staged });
    const r = await s.review();
    const before = t.user["channels.yaml"];
    const write = t.deps.writeUserFile;
    t.deps.writeUserFile = async (n, y) => {
      if (n === "agents.yaml") throw new Error("disk full");
      return write(n, y);
    };
    const res = await s.approveAndSave(r.token);
    expect(res.ok).toBe(false);
    expect(t.user["channels.yaml"]).toBe(before);
  });
});

describe("draft persistence", () => {
  it("a draft saved before channel staging existed opens with no added channels", async () => {
    const t = setup();
    const draft = { version: 1, createdAt: 1_000_000, phase: "channels", secretsCreated: [], channels: [], reusedChannels: [] };
    await t.deps.files.writeAtomic("state/setup-draft.json", JSON.stringify(draft));
    const s = await SetupSession.open(t.deps);
    expect(s.state.addedChannels).toEqual([]);
    await s.cancel();
    expect(t.user["channels.yaml"]).toBe(ORIGINAL);
  });

  it("added channels survive reopening the session", async () => {
    const t = setup();
    const s = await SetupSession.open(t.deps);
    await s.addChannel({ id: "aif", type: "openai-compatible" });
    const again = await SetupSession.open(t.deps);
    expect(again.state.addedChannels).toEqual(["aif"]);
    expect(again.state.channelsBase).toBe(ORIGINAL);
  });
});
