import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), readFile: vi.fn() }));

import * as fsp from "node:fs/promises";
import { PROJECT_ID, route } from "../src/routes.js";

const accessMock = vi.mocked(fsp.access);
const readFileMock = vi.mocked(fsp.readFile);

function setup() {
  const log: string[] = [];
  const dispatchCalls: { method: string; params: unknown }[] = [];
  const results = new Map<string, unknown>();
  const dispatch = vi.fn(async (method: string, params: unknown) => {
    log.push(`dispatch:${method}`);
    dispatchCalls.push({ method, params });
    return results.get(method) ?? {};
  });
  const posted: Record<string, unknown>[] = [];
  const panel = {
    webview: {
      postMessage: vi.fn(async (m: Record<string, unknown>) => {
        log.push(`post:${String(m.type)}`);
        posted.push(m);
      }),
    },
  };
  const host = { userConfigDir: vi.fn(async () => "/cfg") };
  const api = {
    window: {
      showOpenDialog: vi.fn(async () => undefined as { fsPath: string }[] | undefined),
      showTextDocument: vi.fn(async () => ({}) as unknown),
    },
    workspace: { openTextDocument: vi.fn(async () => ({ uri: "doc" }) as unknown) },
    Uri: { file: (p: string) => ({ fsPath: p }) },
  };
  return {
    log,
    dispatchCalls,
    results,
    posted,
    panel,
    host,
    api,
    core: { dispatch },
    run: (m: Record<string, unknown>) => route({ dispatch } as never, host as never, panel as never, m as never, api as never),
  };
}

beforeEach(() => {
  accessMock.mockReset();
  readFileMock.mockReset();
});

describe("routes", () => {
  it("ready dispatches hello then posts ready", async () => {
    const s = setup();
    await s.run({ type: "ready" });
    expect(s.log).toEqual(["dispatch:hello", "post:ready"]);
    expect(s.dispatchCalls[0]).toEqual({
      method: "hello",
      params: { protocol: 1, capabilities: ["stream_events", "approvals", "diff_preview", "diagnostics", "images"] },
    });
    expect(s.posted[0]).toEqual({ type: "ready" });
  });

  it("config.get dispatches projectId and posts config", async () => {
    const s = setup();
    s.results.set("config.get", { summary: { channels: [] } });
    await s.run({ type: "config.get" });
    expect(s.dispatchCalls).toEqual([{ method: "config.get", params: { projectId: PROJECT_ID } }]);
    expect(s.posted[0]).toEqual({ type: "config", summary: { channels: [] } });
  });

  it("config.set dispatches full message then re-gets config in order", async () => {
    const s = setup();
    s.results.set("config.get", { summary: { ok: true } });
    await s.run({ type: "config.set", file: "agents.yaml", yaml: "items: []", projectId: "spoof" });
    expect(s.log).toEqual(["dispatch:config.set", "dispatch:config.get", "post:config"]);
    expect(s.dispatchCalls[0]!.params).toEqual({ type: "config.set", file: "agents.yaml", yaml: "items: []", projectId: PROJECT_ID });
    expect(s.posted[0]).toEqual({ type: "config", summary: { ok: true } });
  });

  it("channel.test picks channelId only and replies with result spread precedence", async () => {
    const s = setup();
    s.results.set("channel.test", { ok: true, models: ["m1"], channelId: "from-result" });
    await s.run({ type: "channel.test", channelId: "c1", extra: "drop-me" });
    expect(s.dispatchCalls[0]).toEqual({ method: "channel.test", params: { projectId: PROJECT_ID, channelId: "c1" } });
    expect(s.posted[0]).toEqual({ type: "channel.test.result", channelId: "from-result", ok: true, models: ["m1"] });
  });

  it("channel.probe picks ids/model/force/bench and replies channel+model", async () => {
    const s = setup();
    s.results.set("channel.probe", { ok: true });
    await s.run({ type: "channel.probe", channelId: "c2", model: "a:b", force: true, bench: false, extra: 1 });
    expect(s.dispatchCalls[0]).toEqual({
      method: "channel.probe",
      params: { projectId: PROJECT_ID, channelId: "c2", model: "a:b", force: true, bench: false },
    });
    expect(s.posted[0]).toEqual({ type: "channel.probe.result", channelId: "c2", model: "a:b", ok: true });
  });

  it("history.list posts history.sessions", async () => {
    const s = setup();
    s.results.set("history.list", { sessions: [{ id: "s1" }] });
    await s.run({ type: "history.list" });
    expect(s.dispatchCalls[0]).toEqual({ method: "history.list", params: { projectId: PROJECT_ID } });
    expect(s.posted[0]).toEqual({ type: "history.sessions", sessions: [{ id: "s1" }] });
  });

  it("history.load picks sessionId and posts history.messages", async () => {
    const s = setup();
    s.results.set("history.load", { messages: [] });
    await s.run({ type: "history.load", sessionId: "s9", extra: "x" });
    expect(s.dispatchCalls[0]).toEqual({ method: "history.load", params: { projectId: PROJECT_ID, sessionId: "s9" } });
    expect(s.posted[0]).toEqual({ type: "history.messages", sessionId: "s9", messages: [] });
  });

  it("history.delete dispatches delete then list in order", async () => {
    const s = setup();
    s.results.set("history.list", { sessions: [] });
    await s.run({ type: "history.delete", sessionId: "s1" });
    expect(s.log).toEqual(["dispatch:history.delete", "dispatch:history.list", "post:history.sessions"]);
    expect(s.dispatchCalls[0]).toEqual({ method: "history.delete", params: { projectId: PROJECT_ID, sessionId: "s1" } });
    expect(s.posted[0]).toEqual({ type: "history.sessions", sessions: [] });
  });

  it("config.importV1 picks xml/apply and marks applied only for exact true", async () => {
    const s = setup();
    s.results.set("config.importV1", { files: { "agents.yaml": "x" }, warnings: ["w"] });
    await s.run({ type: "config.importV1", xml: "<a/>", apply: "yes", projectId: "spoof" });
    expect(s.dispatchCalls[0]).toEqual({ method: "config.importV1", params: { projectId: PROJECT_ID, xml: "<a/>", apply: "yes" } });
    expect(s.posted[0]).toEqual({ type: "v1.draft", files: { "agents.yaml": "x" }, warnings: ["w"], xml: "<a/>", applied: false });
    const s2 = setup();
    s2.results.set("config.importV1", { files: {}, warnings: [] });
    await s2.run({ type: "config.importV1", xml: "<b/>", apply: true });
    expect(s2.posted[0]).toEqual({ type: "v1.draft", files: {}, warnings: [], xml: "<b/>", applied: true });
  });

  it("v1.import reads picked file and posts draft without applied", async () => {
    const s = setup();
    s.api.window.showOpenDialog.mockResolvedValue([{ fsPath: "/tmp/stewart.xml" }]);
    readFileMock.mockResolvedValue("<xml/>");
    s.results.set("config.importV1", { files: { f: "y" }, warnings: ["w1"] });
    await s.run({ type: "v1.import" });
    expect(readFileMock).toHaveBeenCalledWith("/tmp/stewart.xml", "utf8");
    expect(s.dispatchCalls[0]).toEqual({ method: "config.importV1", params: { projectId: PROJECT_ID, xml: "<xml/>" } });
    expect(s.posted[0]).toEqual({ type: "v1.draft", files: { f: "y" }, warnings: ["w1"], xml: "<xml/>" });
    expect(s.posted[0]).not.toHaveProperty("applied");
  });

  it("v1.import dialog cancel dispatches nothing", async () => {
    const s = setup();
    s.api.window.showOpenDialog.mockResolvedValue(undefined);
    await s.run({ type: "v1.import" });
    expect(s.dispatchCalls).toHaveLength(0);
    expect(s.posted).toHaveLength(0);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("setup.recommend picks fields and posts result", async () => {
    const s = setup();
    s.results.set("setup.recommend", { ok: true, assignments: [] });
    await s.run({ type: "setup.recommend", mode: "ai", evaluator: { channel: "c", model: "m" }, context: { priorities: {} }, bench: true, extra: 1 });
    expect(s.dispatchCalls[0]).toEqual({
      method: "setup.recommend",
      params: { projectId: PROJECT_ID, mode: "ai", evaluator: { channel: "c", model: "m" }, context: { priorities: {} }, bench: true },
    });
    expect(s.posted[0]).toEqual({ type: "setup.recommend.result", ok: true, assignments: [] });
  });

  for (const t of ["setup.session.start", "setup.session.get", "setup.session.update", "setup.session.advance", "setup.session.back", "setup.session.cancel"]) {
    it(`routes ${t} with full spread and session.result`, async () => {
      const s = setup();
      s.results.set(t, { phase: "review" });
      await s.run({ type: t, patch: { files: {} }, projectId: "spoof", extra: 7 });
      expect(s.dispatchCalls[0]).toEqual({ method: t, params: { type: t, patch: { files: {} }, projectId: PROJECT_ID, extra: 7 } });
      expect(s.posted[0]).toEqual({ type: "setup.session.result", phase: "review" });
    });
  }

  for (const t of ["setup.probe.start", "setup.probe.status", "setup.probe.cancel", "setup.probe.retry"]) {
    it(`routes ${t} with full spread and probe.result`, async () => {
      const s = setup();
      s.results.set(t, { status: "running" });
      await s.run({ type: t, candidates: [], projectId: "spoof" });
      expect(s.dispatchCalls[0]).toEqual({ method: t, params: { type: t, candidates: [], projectId: PROJECT_ID } });
      expect(s.posted[0]).toEqual({ type: "setup.probe.result", status: "running" });
    });
  }

  for (const t of ["setup.review", "setup.approve", "setup.undo", "setup.session.addChannel", "setup.session.removeChannel"]) {
    it(`routes ${t} and replies ${t}.result`, async () => {
      const s = setup();
      s.results.set(t, { ok: true });
      await s.run({ type: t, token: "tok", projectId: "spoof" });
      expect(s.dispatchCalls[0]).toEqual({ method: t, params: { type: t, token: "tok", projectId: PROJECT_ID } });
      expect(s.posted[0]).toEqual({ type: `${t}.result`, ok: true });
    });
  }

  it("skills.open uses existing file without config fallback", async () => {
    const s = setup();
    accessMock.mockResolvedValue(undefined);
    const doc = { uri: "doc" };
    s.api.workspace.openTextDocument.mockResolvedValue(doc);
    await s.run({ type: "skills.open", id: "s1" });
    expect(accessMock).toHaveBeenCalledWith("/cfg/skills/s1.md");
    expect(s.api.workspace.openTextDocument).toHaveBeenCalledWith({ fsPath: "/cfg/skills/s1.md" });
    expect(s.api.window.showTextDocument).toHaveBeenCalledWith(doc, { preview: false });
    expect(s.dispatchCalls).toHaveLength(0);
  });

  it("skills.open falls back to config summary then saves and opens", async () => {
    const s = setup();
    accessMock.mockRejectedValue(new Error("missing"));
    s.results.set("config.get", { summary: { skills: [{ id: "s2", body: "body", description: "desc" }] } });
    await s.run({ type: "skills.open", id: "s2" });
    expect(s.dispatchCalls.map((c) => c.method)).toEqual(["config.get", "skills.save"]);
    expect(s.dispatchCalls[1]!.params).toEqual({ projectId: PROJECT_ID, id: "s2", body: "body", description: "desc" });
    expect(s.api.window.showTextDocument).toHaveBeenCalled();
  });

  it("skills.open unknown skill posts error", async () => {
    const s = setup();
    accessMock.mockRejectedValue(new Error("missing"));
    s.results.set("config.get", { summary: { skills: [] } });
    await s.run({ type: "skills.open", id: "nope" });
    expect(s.posted).toEqual([{ type: "error", message: "unknown skill: nope" }]);
    expect(s.api.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("unknown and prototype-key types fall through to dispatch", async () => {
    const s = setup();
    await s.run({ type: "chat.send", text: "hi", projectId: "spoof" });
    await s.run({ type: "hasOwnProperty" });
    expect(s.dispatchCalls[0]).toEqual({ method: "chat.send", params: { type: "chat.send", text: "hi", projectId: PROJECT_ID } });
    expect(s.dispatchCalls[1]).toEqual({ method: "hasOwnProperty", params: { type: "hasOwnProperty", projectId: PROJECT_ID } });
    expect(s.posted).toHaveLength(0);
  });

  it("dispatch Error posts error message; non-Error posts String(e)", async () => {
    const s = setup();
    s.core.dispatch.mockRejectedValueOnce(new Error("boom"));
    await s.run({ type: "config.get" });
    expect(s.posted).toEqual([{ type: "error", message: "boom" }]);
    const s2 = setup();
    s2.core.dispatch.mockRejectedValueOnce("plain failure");
    await s2.run({ type: "config.get" });
    expect(s2.posted).toEqual([{ type: "error", message: "plain failure" }]);
  });
});
