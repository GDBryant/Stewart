import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcLink } from "../src/rpc.js";
import { runStdio, type CoreLike } from "../src/server.js";
import { remoteConfigStore, remoteHost } from "../src/host.js";
import { pruneDebugLogs } from "../src/debugSink.js";
import { fakeHost } from "@stewart/kernel";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

describe("RpcLink without a request handler", () => {
  it("answers a request with an error instead of throwing", async () => {
    const out: string[] = [];
    const link = new RpcLink((l) => out.push(l));
    link.feed('{"id":1,"method":"m","params":{}}\n');
    await new Promise((r) => setTimeout(r, 0));
    const res = JSON.parse(out[0]) as { id: number; error?: { message: string } };
    expect(res.error?.message).toContain("no request handler");
  });
});

describe("runStdio wiring", () => {
  it("binds stdin/stdout, tracks announced dirs, and serves attach + dispatch", async () => {
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const coreCalls: string[] = [];
    const core: CoreLike = {
      attachProject: async () => ({ roles: [] }),
      dispatch: async (m) => {
        coreCalls.push(m);
        return { ok: true };
      },
    };
    let announced: string | undefined = "unset";
    try {
      runStdio((ctx) => {
        announced = undefined;
        return {
          ...core,
          attachProject: async (projectId, host) => {
            void host;
            void projectId;
            announced = ctx.logDir();
            return core.attachProject(projectId, host);
          },
        };
      });
      const stdin = process.stdin as unknown as { emit(ev: string, data: string): boolean };
      stdin.emit("data", JSON.stringify({ method: "log.dir", params: { dir: "/tmp/logs" } }) + "\n");
      stdin.emit("data", JSON.stringify({ method: "config.dir", params: { dir: "/tmp/cfg" } }) + "\n");
      stdin.emit("data", JSON.stringify({ id: 7, method: "project.attach", params: { projectId: "p1" } }) + "\n");
      stdin.emit("data", JSON.stringify({ id: 8, method: "chat.cancel", params: { projectId: "p1", runId: "r" } }) + "\n");
      await new Promise((r) => setTimeout(r, 20));
      expect(announced).toBe("/tmp/logs");
      const lines = writes.mock.calls.map((c) => JSON.parse(String(c[0])) as { id: number; result?: unknown });
      const attach = lines.find((l) => l.id === 7);
      expect(attach?.result).toMatchObject({ protocol: 1 });
      expect(coreCalls).toContain("chat.cancel");
    } finally {
      writes.mockRestore();
      for (const l of (process.stdin as unknown as { listeners(e: string): unknown[] }).listeners("data")) {
        process.stdin.removeListener("data", l as (...a: unknown[]) => void);
      }
    }
  });
});

describe("remoteProcess killTree", () => {
  it("swallows a request failure when the link is already closed", async () => {
    const link = new RpcLink(() => {});
    const host = remoteHost(link);
    const proc = host.proc.run(["echo", "hi"], { cwd: "/tmp", onData: () => {} });
    link.close("test done");
    await expect(proc.killTree()).resolves.toBeUndefined();
    await expect(proc.done).resolves.toEqual({ code: -1 });
  });
});

describe("remoteConfigStore", () => {
  it("reads present yaml files and skills, skips absent and non-md entries", async () => {
    const { host, files } = fakeHost({ "/cfg/channels.yaml": "a: 1", "/cfg/skills/s1.md": "skill", "/cfg/skills/note.txt": "x" });
    files["/cfg/settings.yaml"] = "s: 1";
    const store = remoteConfigStore(host, { current: "/cfg" });
    const layer = await store.read();
    expect(layer["channels.yaml"]).toBe("a: 1");
    expect(layer["settings.yaml"]).toBe("s: 1");
    expect(layer["skills/s1.md"]).toBe("skill");
    expect(layer["skills/note.txt"]).toBeUndefined();
    expect(layer["agents.yaml"]).toBeUndefined();
    await store.write("settings.yaml", "s: 2");
    expect(files["/cfg/settings.yaml"]).toBe("s: 2");
  });

  it("returns an empty layer and skips skills when no dir was announced", async () => {
    const { host } = fakeHost();
    const store = remoteConfigStore(host, {});
    expect(await store.read()).toEqual({});
  });
});

describe("pruneDebugLogs", () => {
  it("keeps a debug-log file it cannot unlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-prune-"));
    tmp.push(dir);
    const name = "2000-01-01.log";
    writeFileSync(join(dir, name), "# stewart debug log\nline\n");
    chmodSync(dir, 0o555);
    try {
      expect(pruneDebugLogs(dir, 30)).toEqual([]);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readdirSync(dir)).toContain(name);
  });
});

describe("sidecar entrypoint", () => {
  it("imports main.ts without throwing", async () => {
    await expect(import("../src/main.js")).resolves.toBeDefined();
  });
});
