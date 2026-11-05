import type { ConfigLayer, ConfigStore, HostPort, ProcessHandle } from "@stewart/core";
import type { RpcLink } from "./rpc.js";

/** HostPort implemented as reverse RPC calls into the IDE process. */
export function remoteHost(link: RpcLink): HostPort {
  const call = <T>(method: string, params: unknown): Promise<T> => link.request<T>(`host.${method}`, params);

  return {
    secrets: {
      get: (ref) => call("secrets.get", { ref }),
      set: (ref, value) => call("secrets.set", { ref, value }),
      delete: (ref) => call("secrets.delete", { ref }),
    },
    files: {
      read: (path) => call("files.read", { path }),
      edit: (edit) => call("files.edit", { edit }),
      readBack: (path) => call("files.readBack", { path }),
      exists: (path) => call("files.exists", { path }),
      list: (dir) => call("files.list", { dir }),
      stat: (path) => call("files.stat", { path }),
      readBinary: (path) => call("files.readBinary", { path }),
      writeBinary: (path, base64) => call("files.writeBinary", { path, base64 }),
      writeAtomic: (path, content) => call("files.writeAtomic", { path, content }),
      appendLine: (path, line) => call("files.appendLine", { path, line }),
      readLines: (path) => call("files.readLines", { path }),
      delete: (path) => call("files.delete", { path }),
    },
    proc: {
      run: (argv, opts): ProcessHandle => remoteProcess(link, argv, opts),
    },
    diff: { preview: (path, next) => call("diff.preview", { path, next }) },
    diag: { problems: (path) => call("diag.problems", { path }) },
    editor: { selection: () => call("editor.selection", {}) },
    workspace: {
      roots: () => call("workspace.roots", {}),
      stateDir: () => call("workspace.stateDir", {}),
      trusted: () => call("workspace.trusted", {}),
    },
    log: (line) => link.notify("log", { line }),
  };
}

/**
 * A process started by the IDE. Output arrives as `proc.output` notifications
 * keyed by handle id; exit arrives as `proc.exit` and resolves `done`.
 */
function remoteProcess(link: RpcLink, argv: string[], opts: { cwd: string; env?: Record<string, string>; onData(d: string): void }): ProcessHandle {
  const handle = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let exited = false;
  let resolveDone: (r: { code: number }) => void = () => {};
  const done = new Promise<{ code: number }>((res) => {
    resolveDone = res;
  });

  link.onNotification((method, params) => {
    const p = params as { handle?: string; data?: string; code?: number };
    if (p?.handle !== handle) return;
    if (method === "proc.output" && typeof p.data === "string") opts.onData(p.data);
    if (method === "proc.exit" && !exited) {
      exited = true;
      resolveDone({ code: p.code ?? -1 });
    }
  });

  void link.request("host.proc.run", { handle, argv, cwd: opts.cwd, env: opts.env }).catch(() => {
    if (!exited) {
      exited = true;
      resolveDone({ code: -1 });
    }
  });

  return {
    write: (data) => link.notify("proc.write", { handle, data }),
    cancel: () => link.notify("proc.cancel", { handle }),
    killTree: async () => {
      await link.request("host.proc.killTree", { handle }).catch(() => {});
    },
    done,
  };
}

/**
 * User-level config store backed by the IDE's filesystem: the config dir comes
 * from the host at `project.attach` time, so the store stays path-agnostic.
 */
export function remoteConfigStore(host: HostPort, dir: { current?: string }): ConfigStore {
  const file = (name: string): string => `${dir.current ?? ""}/${name}`;
  return {
    async read(): Promise<ConfigLayer> {
      if (!dir.current) return {};
      const layer: ConfigLayer = {};
      for (const name of ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"]) {
        try {
          layer[name] = (await host.files.read(file(name))).content;
        } catch {
          /* absent file: shipped defaults apply */
        }
      }
      try {
        for (const entry of await host.files.list(file("skills"))) {
          const name = entry.replace(/^.*\//, "");
          if (!name.endsWith(".md")) continue;
          layer[`skills/${name}`] = (await host.files.read(file(`skills/${name}`))).content;
        }
      } catch {
        /* no skills dir yet */
      }
      return layer;
    },
    write: async (name, yaml) => host.files.writeAtomic(file(name), yaml),
    delete: async (name) => host.files.delete(file(name)),
  };
}
