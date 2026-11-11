import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Core, type ConfigLayer, type ConfigStore } from "@stewart/core";
import type { RunEvent } from "@stewart/protocol";
import { VsCodeHost } from "./host.js";
import { PROJECT_ID, route } from "./routes.js";

const CONFIG_FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"];

/** Shared slot for the single chat panel; cleared when the user closes it. */
type PanelRef = { current?: vscode.WebviewPanel };

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

/** Watches the user config dir and pushes a fresh config to the panel after each change. */
async function watchConfig(context: vscode.ExtensionContext, core: Core, host: VsCodeHost, ref: PanelRef): Promise<void> {
  const cfgDir = await host.userConfigDir();
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(cfgDir), "**/*"));
  const refresh = () => {
    void (async () => {
      try {
        const res = (await core.dispatch("config.reload", { projectId: PROJECT_ID, fromWatcher: true })) as { suppressed?: boolean };
        if (res?.suppressed) return;
        const r = await core.dispatch("config.get", { projectId: PROJECT_ID });
        await ref.current?.webview.postMessage({ type: "config", ...(r as object) });
      } catch (e) {
        host.log(`config reload: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);
}

function panelHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "webview.css"));
  const nonce = String(Date.now());
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}

/** Creates the chat webview, wires its messages through `route` in arrival order, and clears `ref` on dispose. */
function createPanel(context: vscode.ExtensionContext, core: Core, host: VsCodeHost, ref: PanelRef): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel("stewart", "Stewart", vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "webview")],
    retainContextWhenHidden: true,
  });
  panel.webview.html = panelHtml(context, panel.webview);
  let routeChain: Promise<void> = Promise.resolve();
  panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => {
    routeChain = routeChain.then(() => route({ core, host, panel, api: vscode }, m)).catch(() => {});
  }, undefined, context.subscriptions);
  panel.onDidDispose(() => (ref.current = undefined));
  return panel;
}

/** Inserts the active editor selection into the chat as an @selection snippet. */
async function insertSelection(host: VsCodeHost, ref: PanelRef): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) return;
  const sel = await host.editor.selection();
  if (!sel) return;
  const snippet = `@selection\n\`\`\`\n// ${sel.path}:${sel.startLine}-${sel.endLine}\n${sel.text}\n\`\`\`\n`;
  await ref.current?.webview.postMessage({ type: "insertText", text: snippet });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const host = new VsCodeHost(context);
  const ref: PanelRef = {};

  const core = new Core({
    defaults: {},
    userConfig: dirStore(await host.userConfigDir()),
    projectConfig: async () => dirStore(await host.projectConfigDir()),
    emitEvent: (ev: RunEvent) => ref.current?.webview.postMessage({ type: "event", ev }),
  });
  await core.attachProject(PROJECT_ID, host);
  await watchConfig(context, core, host, ref);

  const openPanel = () => {
    if (ref.current) {
      ref.current.reveal();
      return;
    }
    ref.current = createPanel(context, core, host, ref);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("stewart.openChat", openPanel),
    vscode.commands.registerCommand("stewart.openSettings", openPanel),
    vscode.commands.registerCommand("stewart.addSelectionToChat", async () => {
      openPanel();
      await insertSelection(host, ref);
    }),
  );
}
