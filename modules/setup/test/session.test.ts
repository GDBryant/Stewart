import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { SetupSession, type SetupSessionDeps, type SetupEvent } from "../src/session.js";

function depsFor(over: Partial<SetupSessionDeps> = {}) {
  const { host, files } = fakeHost();
  const userFiles: Record<string, string | undefined> = { "channels.yaml": "version: 1\nitems: []\n" };
  const deletedSecrets: string[] = [];
  const events: SetupEvent[] = [];
  let now = 1_000_000;
  const deps: SetupSessionDeps = {
    files: host.files,
    stateDir: "state",
    readUserFiles: async () => ({ ...userFiles }),
    writeUserFile: async (name, yaml) => {
      userFiles[name] = yaml;
    },
    deleteSecret: async (ref) => {
      deletedSecrets.push(ref);
    },
    onEvent: (ev) => events.push(ev),
    now: () => now,
    ...over,
  };
  return { deps, files, userFiles, deletedSecrets, events, tick: (ms: number) => (now += ms) };
}

const stagedChannels = { channels: [{ id: "ollama", tested: "ok" as const, models: ["m1"] }] };
const stages = async (s: SetupSession, d: ReturnType<typeof depsFor>) => {
  await s.update({ ...stagedChannels, secretsCreated: ["sec:a"] });
  expect((await s.advance()).ok).toBe(true);
  await s.update({ evaluator: "rules" });
  expect((await s.advance()).ok).toBe(true);
  s.startEvaluation(2);
  s.recordCandidate("m1", "evaluated", { ok: true });
  s.recordCandidate("m2", "unavailable", undefined, "down");
  s.finishEvaluation();
  await s.update({});
  expect((await s.advance()).ok).toBe(true);
  await s.update({ assignment: { "code-writer": "a1" }, assignmentValid: true });
  expect((await s.advance()).ok).toBe(true);
};

describe("SetupSession", () => {
  it("walks the five phases with gates and persists the draft", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    expect(s.phase).toBe("channels");
    expect((await s.advance()).ok).toBe(false);
    await s.update({ ...stagedChannels, secretsCreated: ["sec:a"] });
    expect((await s.advance()).ok).toBe(true);
    expect(s.phase).toBe("evaluator");
    const resumed = await SetupSession.open(d.deps);
    expect(resumed.phase).toBe("evaluator");
    expect(resumed.state.secretsCreated).toEqual(["sec:a"]);
  });

  it("expires drafts older than 7 days", async () => {
    const d = depsFor();
    await (await SetupSession.open(d.deps)).update(stagedChannels);
    d.tick(8 * 24 * 3600 * 1000);
    expect((await SetupSession.open(d.deps)).phase).toBe("channels");
    expect((await SetupSession.open(d.deps)).state.channels).toEqual([]);
  });

  it("back moves freely; changing evaluator marks evaluation stale", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    expect(s.phase).toBe("approve");
    await s.back();
    await s.back();
    expect(s.phase).toBe("evaluate");
    await s.update({ evaluator: { channel: "c", model: "m" } });
    expect(s.state.evaluation?.stale).toBe(true);
  });

  it("cancel deletes session secrets and the draft, writing no yaml", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    await s.update({ ...stagedChannels, secretsCreated: ["sec:a", "sec:b"] });
    await s.cancel();
    expect(d.deletedSecrets.sort()).toEqual(["sec:a", "sec:b"]);
    expect(await d.files["state/setup-draft.json"]).toBeUndefined();
    expect(d.userFiles["agents.yaml"]).toBeUndefined();
  });

  it("evaluation counters are monotonic with tally summing to done", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    s.startEvaluation(3);
    s.recordCandidate("a", "evaluated", { ok: 1 });
    s.recordCandidate("b", "skipped");
    s.recordCandidate("c", "unavailable", undefined, "x");
    s.recordCandidate("d", "evaluated", {}); // over total: ignored
    const ev = s.state.evaluation!;
    expect(ev.done).toBe(3);
    expect(ev.tally.evaluated + ev.tally.unavailable + ev.tally.skipped).toBe(ev.done);
    s.finishEvaluation();
    const progress = d.events.filter((e) => e.kind === "progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1] as Extract<SetupEvent, { kind: "progress" }>;
    expect(last.done).toBe(3);
    expect(progress.every((e) => e.done <= e.total)).toBe(true);
  });

  it("approveAndSave writes all files atomically, backs up, deletes the draft", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    await s.update({ files: { "agents.yaml": "v:1", "roles.yaml": "v:1" } });
    const { token } = await s.review();
    const res = await s.approveAndSave(token);
    expect(res.ok).toBe(true);
    expect(d.userFiles["agents.yaml"]).toBe("v:1");
    expect(d.userFiles["channels.yaml"]).toContain("items");
    expect(d.files[`state/setup-backups/1000000/channels.yaml`]).toContain("items");
    expect(d.files["state/setup-draft.json"]).toBeUndefined();
    expect((await SetupSession.open(d.deps)).phase).toBe("channels");
  });

  it("rejects stale approval tokens and base changes", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    await s.update({ files: { "agents.yaml": "v:1" } });
    const { token } = await s.review();
    expect((await s.approveAndSave("wrong")).error).toBe("stale_approval");
    d.userFiles["roles.yaml"] = "changed on disk";
    expect((await s.approveAndSave(token)).error).toBe("stale_approval");
    expect(d.userFiles["agents.yaml"]).toBeUndefined();
  });

  it("rejects invalid file sets without writing", async () => {
    const d = depsFor({ validateFiles: () => "roles.yaml: bad schema" });
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    await s.update({ files: { "roles.yaml": "bad" } });
    const { token } = await s.review();
    const res = await s.approveAndSave(token);
    expect(res.error).toBe("roles.yaml: bad schema");
    expect(d.userFiles["roles.yaml"]).toBeUndefined();
  });

  it("restores the backup when a write fails mid-save", async () => {
    const d = depsFor();
    const user = d.userFiles;
    let calls = 0;
    d.deps.writeUserFile = async (name, yaml) => {
      calls++;
      if (calls === 2) throw new Error("disk full");
      user[name] = yaml;
    };
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    await s.update({ files: { "agents.yaml": "v:1", "channels.yaml": "new" } });
    const { token } = await s.review();
    const res = await s.approveAndSave(token);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("disk full");
    expect(d.userFiles["channels.yaml"]).toContain("items"); // restored
    expect(d.userFiles["agents.yaml"]).toBeUndefined();
  });

  it("undo restores the newest backup", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    await stages(s, d);
    await s.update({ files: { "channels.yaml": "changed" } });
    const { token } = await s.review();
    expect((await s.approveAndSave(token)).ok).toBe(true);
    expect(d.userFiles["channels.yaml"]).toBe("changed");
    expect((await s.undo()).ok).toBe(true);
    expect(d.userFiles["channels.yaml"]).toContain("items");
  });

  it("undo without a backup reports an error", async () => {
    const d = depsFor();
    const s = await SetupSession.open(d.deps);
    expect((await s.undo()).ok).toBe(false);
  });
});
