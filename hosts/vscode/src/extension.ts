import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Core, type ConfigLayer, type ConfigStore } from "@stewart/core";
import type { RunEvent } from "@stewart/protocol";
import { VsCodeHost } from "./host.js";

const PROJECT_ID = "workspace";

const CONFIG_FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"];

function dirStore(dir: string): ConfigStore {
  return {
    read: async () => {
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
    },
    write: async (file, yaml) => {
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, file);
      const tmp = `${target}.tmp-${Date.now()}`;
      await fs.writeFile(tmp, yaml, "utf8");
      await fs.rename(tmp, target);
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const host = new VsCodeHost(context);
  let panel: vscode.WebviewPanel | undefined;

  const core = new Core({
    defaults: {},
    userConfig: dirStore(await host.userConfigDir()),
    projectConfig: async () => dirStore(await host.projectConfigDir()),
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
    vscode.commands.registerCommand("stewart.openSettings", openPanel),
  );
}

async function route(core: Core, panel: vscode.WebviewPanel, m: { type: string; [k: string]: unknown }): Promise<void> {
  try {
    switch (m.type) {
      case "ready":
        await core.dispatch("hello", { protocol: 1, capabilities: ["stream_events", "approvals", "diff_preview", "diagnostics", "images"] });
        await panel.webview.postMessage({ type: "ready" });
        return;
      case "config.get": {
        const r = await core.dispatch("config.get", { projectId: PROJECT_ID });
        await panel.webview.postMessage({ type: "config", ...(r as object) });
        return;
      }
      case "channel.test": {
        const r = await core.dispatch("channel.test", { projectId: PROJECT_ID, channelId: m.channelId });
        await panel.webview.postMessage({ type: "channel.test.result", channelId: m.channelId, ...(r as object) });
        return;
      }
      default: {
        const method = m.type as
          | "chat.send"
          | "chat.cancel"
          | "chat.resume"
          | "chat.answer"
          | "chat.approve"
          | "config.set"
          | "secret.set"
          | "secret.delete";
        await core.dispatch(method, { ...m, projectId: PROJECT_ID });
        return;
      }
    }
  } catch (e) {
    await panel.webview.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
