import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Core } from "@stewart/core";
import type { VsCodeHost } from "./host.js";

export const PROJECT_ID = "workspace";

type RouteMessage = { type: string; [k: string]: unknown };
type Api = Pick<typeof import("vscode"), "window" | "workspace" | "Uri">;
type Panel = Pick<vscode.WebviewPanel, "webview">;
type CoreLike = Pick<Core, "dispatch">;
type HostLike = Pick<VsCodeHost, "userConfigDir">;
type Ctx = { core: CoreLike; host: HostLike; panel: Panel; api: Api };
type Handler = (ctx: Ctx, m: RouteMessage) => Promise<void>;

async function dispatchAndReply(ctx: Ctx, method: string, params: unknown, reply: Record<string, unknown>): Promise<void> {
  const r = await ctx.core.dispatch(method, params);
  await ctx.panel.webview.postMessage({ ...reply, ...(r as object) });
}

const setupSession: Handler = (ctx, m) => dispatchAndReply(ctx, m.type, { ...m, projectId: PROJECT_ID }, { type: "setup.session.result" });
const setupProbe: Handler = (ctx, m) => dispatchAndReply(ctx, m.type, { ...m, projectId: PROJECT_ID }, { type: "setup.probe.result" });
const setupStaged: Handler = (ctx, m) => dispatchAndReply(ctx, m.type, { ...m, projectId: PROJECT_ID }, { type: `${m.type}.result` });

const ROUTES: Record<string, Handler> = {
  ready: async (ctx) => {
    await ctx.core.dispatch("hello", { protocol: 1, capabilities: ["stream_events", "approvals", "diff_preview", "diagnostics", "images"] });
    await ctx.panel.webview.postMessage({ type: "ready" });
  },
  "config.get": (ctx) => dispatchAndReply(ctx, "config.get", { projectId: PROJECT_ID }, { type: "config" }),
  "config.set": async (ctx, m) => {
    await ctx.core.dispatch("config.set", { ...m, projectId: PROJECT_ID });
    await dispatchAndReply(ctx, "config.get", { projectId: PROJECT_ID }, { type: "config" });
  },
  "channel.test": (ctx, m) =>
    dispatchAndReply(ctx, "channel.test", { projectId: PROJECT_ID, channelId: m.channelId }, { type: "channel.test.result", channelId: m.channelId }),
  "channel.probe": (ctx, m) =>
    dispatchAndReply(
      ctx,
      "channel.probe",
      { projectId: PROJECT_ID, channelId: m.channelId, model: m.model, force: m.force, bench: m.bench },
      { type: "channel.probe.result", channelId: m.channelId, model: m.model },
    ),
  "history.list": (ctx) => dispatchAndReply(ctx, "history.list", { projectId: PROJECT_ID }, { type: "history.sessions" }),
  "history.load": (ctx, m) =>
    dispatchAndReply(ctx, "history.load", { projectId: PROJECT_ID, sessionId: m.sessionId }, { type: "history.messages", sessionId: m.sessionId }),
  "history.delete": async (ctx, m) => {
    await ctx.core.dispatch("history.delete", { projectId: PROJECT_ID, sessionId: m.sessionId });
    await dispatchAndReply(ctx, "history.list", { projectId: PROJECT_ID }, { type: "history.sessions" });
  },
  "config.importV1": async (ctx, m) => {
    const r = (await ctx.core.dispatch("config.importV1", { projectId: PROJECT_ID, xml: m.xml, apply: m.apply })) as {
      files: Record<string, string>;
      warnings: string[];
    };
    await ctx.panel.webview.postMessage({ type: "v1.draft", files: r.files, warnings: r.warnings, xml: m.xml, applied: m.apply === true });
  },
  "v1.import": async (ctx) => {
    const picked = await ctx.api.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "IntelliJ settings": ["xml"] },
      title: "Pick stewart.xml",
    });
    if (!picked?.length) return;
    const xml = await fs.readFile(picked[0].fsPath, "utf8");
    const r = (await ctx.core.dispatch("config.importV1", { projectId: PROJECT_ID, xml })) as {
      files: Record<string, string>;
      warnings: string[];
    };
    await ctx.panel.webview.postMessage({ type: "v1.draft", files: r.files, warnings: r.warnings, xml });
  },
  "setup.recommend": (ctx, m) =>
    dispatchAndReply(
      ctx,
      "setup.recommend",
      { projectId: PROJECT_ID, mode: m.mode, evaluator: m.evaluator, context: m.context, bench: m.bench },
      { type: "setup.recommend.result" },
    ),
  "setup.session.start": setupSession,
  "setup.session.get": setupSession,
  "setup.session.update": setupSession,
  "setup.session.advance": setupSession,
  "setup.session.back": setupSession,
  "setup.session.cancel": setupSession,
  "setup.probe.start": setupProbe,
  "setup.probe.status": setupProbe,
  "setup.probe.cancel": setupProbe,
  "setup.probe.retry": setupProbe,
  "setup.review": setupStaged,
  "setup.approve": setupStaged,
  "setup.undo": setupStaged,
  "skills.open": async (ctx, m) => {
    const file = path.join(await ctx.host.userConfigDir(), "skills", `${String(m.id)}.md`);
    try {
      await fs.access(file);
    } catch {
      const r = (await ctx.core.dispatch("config.get", { projectId: PROJECT_ID })) as {
        summary: { skills: { id: string; body: string; description: string }[] };
      };
      const s = r.summary.skills.find((x) => x.id === m.id);
      if (!s) throw new Error(`unknown skill: ${String(m.id)}`);
      await ctx.core.dispatch("skills.save", { projectId: PROJECT_ID, id: m.id, body: s.body, description: s.description });
    }
    const doc = await ctx.api.workspace.openTextDocument(ctx.api.Uri.file(file));
    await ctx.api.window.showTextDocument(doc, { preview: false });
  },
};

const fallback: Handler = async (ctx, m) => {
  await ctx.core.dispatch(m.type, { ...m, projectId: PROJECT_ID });
};

export async function route(core: CoreLike, host: HostLike, panel: Panel, m: RouteMessage, api: Api): Promise<void> {
  const ctx: Ctx = { core, host, panel, api };
  try {
    const handler = Object.hasOwn(ROUTES, m.type) ? ROUTES[m.type] : fallback;
    await handler(ctx, m);
  } catch (e) {
    await panel.webview.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
