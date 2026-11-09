import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Core, type ConfigLayer, type ConfigStore } from "@stewart/core";
import type { RunEvent } from "@stewart/protocol";
import { VsCodeHost } from "./host.js";
import { PROJECT_ID, route } from "./routes.js";

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
        const res = (await core.dispatch("config.reload", { projectId: PROJECT_ID, fromWatcher: true })) as { suppressed?: boolean };
        if (res?.suppressed) return;
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
    let routeChain: Promise<void> = Promise.resolve();
    panel.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => {
      routeChain = routeChain.then(() => route(core, host, panel!, m, vscode)).catch(() => {});
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => (panel = undefined));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("stewart.openChat", openPanel),
    vscode.commands.registerCommand("stewart.openSettings", openPanel),
    vscode.commands.registerCommand("stewart.addSelectionToChat", async () => {
      openPanel();
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) return;
      const sel = await host.editor.selection();
      if (!sel) return;
      const snippet = `@selection\n\`\`\`\n// ${sel.path}:${sel.startLine}-${sel.endLine}\n${sel.text}\n\`\`\`\n`;
      await panel?.webview.postMessage({ type: "insertText", text: snippet });
    }),
  );
}
