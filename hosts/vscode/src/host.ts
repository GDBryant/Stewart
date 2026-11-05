import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostPort, ProcessHandle, VersionedEdit } from "@stewart/core";

/** HostPort implemented on the vscode API: native undo, unsaved buffers, SecretStorage. */
export class VsCodeHost implements HostPort {
  constructor(private context: vscode.ExtensionContext) {}

  private wsRoot(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) throw new Error("no workspace folder");
    return ws.uri.fsPath;
  }

  private docFor(path: string): Thenable<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, path));
  }

  readonly secrets: HostPort["secrets"] = {
    get: async (ref) => this.context.secrets.get(ref),
    set: async (ref, v) => this.context.secrets.store(ref, v),
    delete: async (ref) => this.context.secrets.delete(ref),
  };

  readonly files: HostPort["files"] = {
    read: async (p) => {
      const doc = await this.docFor(p);
      return { content: doc.getText(), version: doc.version };
    },
    edit: async (e: VersionedEdit) => {
      const doc = await this.docFor(e.path);
      if (e.baseVersion !== undefined && doc.version !== e.baseVersion) {
        throw new Error(`stale preview for ${e.path}: expected v${e.baseVersion}, doc is v${doc.version}`);
      }
      const edit = new vscode.WorkspaceEdit();
      if (e.content !== undefined) {
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(doc.uri, full, e.content);
      } else {
        for (const ed of e.edits ?? []) {
          const idx = doc.getText().indexOf(ed.oldText);
          if (idx < 0) throw new Error(`anchor not found in ${e.path}`);
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + ed.oldText.length)), ed.newText);
        }
      }
      const ok = await vscode.workspace.applyEdit(edit); // one native undo step
      if (!ok) throw new Error(`edit rejected for ${e.path}`);
      return { applied: true as const, version: doc.version };
    },
    readBack: async (p) => (await this.docFor(p)).getText(),
    exists: async (p) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, p));
        return true;
      } catch {
        return false;
      }
    },
    list: async (dir) => {
      const root = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, dir || ".");
      const out: string[] = [];
      const walk = async (uri: vscode.Uri, rel: string) => {
        for (const [name, ftype] of await vscode.workspace.fs.readDirectory(uri)) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const r = rel ? `${rel}/${name}` : name;
          if (ftype === vscode.FileType.Directory) await walk(vscode.Uri.joinPath(uri, name), r);
          else if (ftype === vscode.FileType.File) out.push(r);
          if (out.length >= 20_000) return;
        }
      };
      await walk(root, dir);
      return out;
    },
    stat: async (p) => {
      const s = await vscode.workspace.fs.stat(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, p));
      return { size: s.size };
    },
    writeAtomic: async (p, content) => {
      const uri = vscode.Uri.file(p);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = uri.with({ path: `${uri.path}.tmp-${Date.now()}` });
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, "utf8"));
      await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
    },
    appendLine: async (p, line) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      const fh = await fs.open(p, "a");
      try {
        await fh.write(`${line}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    readLines: async (p) => {
      try {
        return (await fs.readFile(p, "utf8")).split("\n").filter((l) => l.length > 0);
      } catch {
        return [];
      }
    },
    delete: async (p) => {
      try {
        await fs.rm(p, { force: true });
      } catch {
        /* absent file is not an error */
      }
    },
  };

  readonly proc: HostPort["proc"] = {
    run: (argv, opts): ProcessHandle => {
      const child: ChildProcess = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: false });
      child.stdout?.on("data", (d) => opts.onData(String(d)));
      child.stderr?.on("data", (d) => opts.onData(String(d)));
      const done = new Promise<{ code: number }>((res) => child.on("exit", (code) => res({ code: code ?? -1 })));
      return {
        cancel: () => child.kill("SIGTERM"),
        killTree: async () => {
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        },
        done,
      };
    },
  };

  readonly diff: HostPort["diff"] = {
    preview: async (p, next) => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, p);
      await vscode.commands.executeCommand("vscode.diff", uri.with({ scheme: "untitled" }), uri, `Stewart: ${path.basename(p)}`);
    },
  };

  readonly diag: HostPort["diag"] = {
    problems: async (p) => {
      const all = vscode.languages.getDiagnostics();
      const out: { path: string; line: number; message: string; severity: string }[] = [];
      const root = this.wsRoot();
      for (const [uri, diags] of all) {
        const rel = path.relative(root, uri.fsPath);
        if (p && rel !== p) continue;
        for (const d of diags) out.push({ path: rel, line: d.range.start.line + 1, message: d.message, severity: vscode.DiagnosticSeverity[d.severity] });
      }
      return out;
    },
  };

  readonly workspace: HostPort["workspace"] = {
    roots: async () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    stateDir: async () => this.context.globalStorageUri.fsPath,
    trusted: async () => vscode.workspace.isTrusted,
  };

  private channel?: vscode.OutputChannel;
  log(line: string): void {
    (this.channel ??= vscode.window.createOutputChannel("Stewart")).appendLine(line);
  }

  async userConfigDir(): Promise<string> {
    const dir = path.join(this.context.globalStorageUri.fsPath, "user-config");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async projectConfigDir(): Promise<string> {
    return path.join(this.wsRoot(), ".stewart");
  }
}
