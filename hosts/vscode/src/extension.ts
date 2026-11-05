import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Core, type ConfigLayer } from "@stewart/core";
import type { RunEvent } from "@stewart/protocol";
import { VsCodeHost } from "./host.js";

const PROJECT_ID = "workspace";

const CONFIG_FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"];

async function readLayer(dir: string): Promise<ConfigLayer> {
  const layer: ConfigLayer = {};
  for (const f of CONFIG_FILES) {
    try {
      layer[f] = await fs.readFile(path.join(dir, f), "utf8");
    } catch {
      /* absent file = empty layer */
    }
  }
  try {
    const skills = await fs.readdir(path.join(dir, "skills"));
    if (skills.length) layer["skills/"] = skills.join("\n");
  } catch {
    /* no skills dir */
  }
  return layer;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const host = new VsCodeHost(context);
  let panel: vscode.WebviewPanel | undefined;

  const core = new Core({
    defaults: {},
    userConfig: () => host.userConfigDir().then(readLayer),
    projectConfig: () => host.projectConfigDir().then(readLayer),
    emitEvent: (ev: RunEvent) => panel?.webview.postMessage({ type: "event", ev }),
  });
  await core.attachProject(PROJECT_ID, host);

  const openPanel = () => {
    if (panel) {
      panel.reveal();
      return;
    }
    panel = vscode.window.createWebviewPanel("stewart", "Stewart", vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "webview")],
      retainContextWhenHidden: true,
    });
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "webview.js"));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "webview.css"));
    const nonce = String(Date.now());
    panel.webview.html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void route(core, panel!, m), undefined, context.subscriptions);
    panel.onDidDispose(() => (panel = undefined));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("stewart.openChat", openPanel),
    vscode.commands.registerCommand("stewart.openSettings", () => {
      openPanel();
      // The webview switches to the settings tab on config reply.
    }),
  );
}

async function route(core: Core, panel: vscode.WebviewPanel, m: { type: string; [k: string]: unknown }): Promise<void> {
  try {
    switch (m.type) {
      case "ready":
        await core.dispatch("hello", { protocol: 1, capabilities: ["stream_events", "approvals", "diff_preview", "diagnostics", "images"] });
        await panel.webview.postMessage({ type: "ready" });
        return;
      case "chat.send":
        await core.dispatch("chat.send", { projectId: PROJECT_ID, text: m.text, images: m.images, direct: m.direct });
        return;
      case "chat.cancel":
        await core.dispatch("chat.cancel", { projectId: PROJECT_ID, runId: m.runId });
        return;
      case "chat.resume":
        await core.dispatch("chat.resume", { projectId: PROJECT_ID, runId: m.runId });
        return;
      case "chat.answer":
        await core.dispatch("chat.answer", { projectId: PROJECT_ID, questionId: m.questionId, answer: m.answer });
        return;
      case "chat.approve":
        await core.dispatch("chat.approve", { projectId: PROJECT_ID, approvalId: m.approvalId, grant: m.grant });
        return;
      case "config.get": {
        const r = (await core.dispatch("config.get", { projectId: PROJECT_ID })) as { yaml: string };
        await panel.webview.postMessage({ type: "config", yaml: r.yaml });
        return;
      }
      case "config.set":
        await core.dispatch("config.set", { projectId: PROJECT_ID, file: m.file, yaml: m.yaml });
        return;
      case "channel.test": {
        const r = await core.dispatch("channel.test", { projectId: PROJECT_ID, channelId: m.channelId });
        await panel.webview.postMessage({ type: "channel.test.result", channelId: m.channelId, ...(r as object) });
        return;
      }
    }
  } catch (e) {
    host_log(panel, e instanceof Error ? e.message : String(e));
  }
}

function host_log(panel: vscode.WebviewPanel, msg: string): void {
  void panel.webview.postMessage({ type: "event", ev: { kind: "run.finished", runId: "", status: "failed", error: msg } });
}
