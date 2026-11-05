import type { ConfigStore, HostPort } from "@stewart/core";
import { RpcLink } from "./rpc.js";
import { remoteConfigStore, remoteHost } from "./host.js";

/** The slice of Core the transport needs; keeps the sidecar testable without a real Core. */
export interface CoreLike {
  attachProject(projectId: string, host: HostPort): Promise<unknown>;
  dispatch(method: string, params: unknown): Promise<unknown>;
}

export interface SidecarContext {
  emit(ev: unknown): void;
  host: HostPort;
  store: ConfigStore;
  projectStore: ConfigStore;
}

export const SIDECAR_PROTOCOL = 1;

/**
 * Wire one Core instance to an IDE over NDJSON JSON-RPC: `project.attach` binds
 * a project to the remote HostPort (and tells core where the user config lives),
 * every other method is a Core dispatch, and core events are pushed back as
 * `event` notifications.
 */
export function serve(core: CoreLike, link: RpcLink, opts: { protocol?: number } = {}): void {
  const host = remoteHost(link);
  const attached = new Set<string>();

  link.onRequest(async (method, params) => {
    if (method === "project.attach") {
      const p = params as { projectId: string; protocol?: number; userConfigDir?: string };
      const wanted = p.protocol ?? SIDECAR_PROTOCOL;
      if (wanted !== SIDECAR_PROTOCOL) throw new Error(`incompatible protocol ${wanted}; sidecar speaks ${SIDECAR_PROTOCOL}`);
      const config = await core.attachProject(p.projectId, host);
      attached.add(p.projectId);
      return { protocol: SIDECAR_PROTOCOL, config };
    }
    const p = (params ?? {}) as { projectId?: string };
    if (typeof p.projectId === "string" && !attached.has(p.projectId)) {
      await core.attachProject(p.projectId, host);
      attached.add(p.projectId);
    }
    return core.dispatch(method, params);
  });
}

/** Main-process wiring: stdin → link, link → stdout, core events → `event` notifications. */
export function runStdio(factory: (ctx: SidecarContext) => CoreLike): RpcLink {
  const link = new RpcLink((line) => process.stdout.write(`${line}\n`));
  const host = remoteHost(link);
  const dir: { current?: string } = {};
  const projectDir: { current?: string } = {};
  const store = remoteConfigStore(host, dir);
  const projectStore = remoteConfigStore(host, projectDir);
  link.onNotification((method, params) => {
    if (method === "config.dir") dir.current = (params as { dir?: string }).dir;
    if (method === "config.projectDir") projectDir.current = (params as { dir?: string }).dir;
  });
  serve(factory({ emit: (ev) => link.notify("event", ev), host, store, projectStore }), link);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => link.feed(chunk));
  process.stdin.on("end", () => link.close("stdin closed"));
  return link;
}
