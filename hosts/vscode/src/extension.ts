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
        for (const f of skills.filter((s) => s.endsWith(".md"))) {
          layer[`skills/${f}`] = await fs.readFile(path.join(dir, "skills", f), "utf8");
        }
      } catch {
        /* no skills dir */
      }
      return layer;
    },
    write: async (file, yaml) => {
      const target = path.join(dir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${Date.now()}`;
      await fs.writeFile(tmp, yaml, "utf8");
      await fs.rename(tmp, target);
    },
    delete: async (file) => {
      await fs.rm(path.join(dir, file), { force: true });
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

  const cfgDir = await host.userConfigDir();
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(cfgDir), "**/*"));
  const refresh = () => {
    void (async () => {
      try {
        await core.dispatch("config.reload", { projectId: PROJECT_ID });
        const r = await core.dispatch("config.get", { projectId: PROJECT_ID });
        await panel?.webview.postMessage({ type: "config", ...(r as object) });
      } catch (e) {
        host.log(`config reload: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);

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
    panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void route(core, host, panel!, m), undefined, context.subscriptions);
    panel.onDidDispose(() => (panel = undefined));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("stewart.openChat", openPanel),
    vscode.commands.registerCommand("stewart.openSettings", openPanel),
  );
}

async function route(core: Core, host: VsCodeHost, panel: vscode.WebviewPanel, m: { type: string; [k: string]: unknown }): Promise<void> {
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
      case "skills.open": {
        const file = path.join(await host.userConfigDir(), "skills", `${String(m.id)}.md`);
        try {
          await fs.access(file);
        } catch {
          const r = (await core.dispatch("config.get", { projectId: PROJECT_ID })) as {
            summary: { skills: { id: string; body: string; description: string }[] };
          };
          const s = r.summary.skills.find((x) => x.id === m.id);
          if (!s) throw new Error(`unknown skill: ${String(m.id)}`);
          await core.dispatch("skills.save", { projectId: PROJECT_ID, id: m.id, body: s.body, description: s.description });
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: false });
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
          | "secret.delete"
          | "skills.save"
          | "skills.reset"
          | "roles.reset"
          | "roles.assignAgent";
        await core.dispatch(method, { ...m, projectId: PROJECT_ID });
        return;
      }
    }
  } catch (e) {
    await panel.webview.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
