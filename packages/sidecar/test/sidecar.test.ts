import { describe, expect, it } from "vitest";
import { RpcLink } from "../src/rpc.js";
import { serve, type CoreLike } from "../src/server.js";
import { remoteConfigStore, remoteHost } from "../src/host.js";
import { fakeHost } from "@stewart/kernel";

function pair() {
  const out: string[] = [];
  const link = new RpcLink((line) => out.push(line));
  return { link, out, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function fakeCore(): CoreLike & { attached: { projectId: string; host: unknown }[]; calls: { method: string; params: unknown }[] } {
  const attached: { projectId: string; host: unknown }[] = [];
  const calls: { method: string; params: unknown }[] = [];
  return {
    attached,
    calls,
    attachProject: async (projectId, host) => {
      attached.push({ projectId, host });
      return { roles: [] };
    },
    dispatch: async (method, params) => {
      calls.push({ method, params });
      return { ok: true, method };
    },
  };
}

describe("RpcLink", () => {
  it("buffers partial lines and dispatches complete ones", async () => {
    const { link } = pair();
    const seen: unknown[] = [];
    link.onRequest(async (method, params) => {
      seen.push([method, params]);
      return "ok";
    });
    link.feed('{"id":1,"method":"a","para');
    expect(seen).toHaveLength(0);
    link.feed('ms":{"x":1}}\n');
    await Promise.resolve();
    expect(seen).toEqual([["a", { x: 1 }]]);
  });

  it("handles several messages in one chunk", async () => {
    const { link } = pair();
    const seen: string[] = [];
    link.onRequest(async (method) => {
      seen.push(method);
      return null;
    });
    link.feed('{"id":1,"method":"a"}\n{"id":2,"method":"b"}\n');
    await Promise.resolve();
    expect(seen).toEqual(["a", "b"]);
  });

  it("correlates responses to pending requests", async () => {
    const { link, lines } = pair();
    const p = link.request("host.files.read", { path: "a" });
    const sent = lines()[0];
    expect(sent).toMatchObject({ method: "host.files.read", params: { path: "a" } });
    link.feed(`${JSON.stringify({ id: sent.id, result: { content: "hi" } })}\n`);
    expect(await p).toEqual({ content: "hi" });
  });

  it("rejects a request whose response carries an error", async () => {
    const { link, lines } = pair();
    const p = link.request("x");
    link.feed(`${JSON.stringify({ id: lines()[0].id, error: { message: "boom" } })}\n`);
    await expect(p).rejects.toThrow("boom");
  });

  it("replies with an error object when a handler throws", async () => {
    const { link, lines } = pair();
    link.onRequest(async () => {
      throw new Error("bad");
    });
    link.feed('{"id":7,"method":"x"}\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(lines().find((l) => l.id === 7)).toMatchObject({ error: { message: "bad" } });
  });

  it("reports malformed JSON without killing the link", () => {
    const { link, lines } = pair();
    link.feed("{oops\n");
    expect(lines()[0]).toMatchObject({ method: "protocol.error" });
    link.feed('{"method":"notify"}\n');
    expect(lines()).toHaveLength(1);
    const p = link.request("still-alive");
    expect(lines().at(-1)).toMatchObject({ method: "still-alive" });
    p.catch(() => {});
  });

  it("emits protocol.error on an oversized buffered line and stays open", () => {
    const { link } = pair();
    const out: string[] = [];
    const capped = new RpcLink((l) => out.push(l), 10);
    capped.feed("x".repeat(50));
    expect(capped.closed).toBe(false);
    expect(out.map((l) => JSON.parse(l))).toEqual([{ method: "protocol.error", params: { message: "rpc line too large" } }]);
    link.close("test");
    expect(link.closed).toBe(true);
  });

  it("never dispatches a complete oversized line but keeps parsing the next line", () => {
    const out: string[] = [];
    const link = new RpcLink((l) => out.push(l), 25);
    const seen: string[] = [];
    link.onRequest(async (method) => {
      seen.push(method);
      return "ok";
    });
    link.feed(`${JSON.stringify({ id: 1, method: "x".repeat(50) })}\n`);
    link.feed('{"id":2,"method":"k"}\n');
    expect(seen).toEqual(["k"]);
    expect(out.map((l) => JSON.parse(l))).toContainEqual({ method: "protocol.error", params: { message: "rpc line too large" } });
    expect(link.closed).toBe(false);
  });

  it("ignores feed once closed", () => {
    const { link } = pair();
    const seen: string[] = [];
    link.onRequest(async (method) => {
      seen.push(method);
      return "ok";
    });
    link.close("test");
    link.feed('{"id":1,"method":"x"}\n');
    expect(seen).toHaveLength(0);
  });

  it("measures the line cap in UTF-8 bytes, not characters", () => {
    const out: string[] = [];
    const link = new RpcLink((l) => out.push(l), 21);
    const seen: string[] = [];
    link.onRequest(async (method) => {
      seen.push(method);
      return "ok";
    });
    link.feed(`${JSON.stringify({ id: 1, method: "éé" })}\n`);
    link.feed('{"id":2,"method":"k"}\n');
    expect(seen).toEqual(["k"]);
    expect(out.map((l) => JSON.parse(l))).toContainEqual({ method: "protocol.error", params: { message: "rpc line too large" } });
  });

  it("rejects pending requests when closed", async () => {
    const { link } = pair();
    const p = link.request("slow");
    link.close("stdin closed");
    await expect(p).rejects.toThrow("stdin closed");
    await expect(link.request("after")).rejects.toThrow("rpc link closed");
  });

  it("notifies every subscriber", () => {
    const { link } = pair();
    const a: string[] = [];
    const b: string[] = [];
    link.onNotification((m) => a.push(m));
    link.onNotification((m) => b.push(m));
    link.feed('{"method":"proc.output","params":{"handle":"h"}}\n');
    expect(a).toEqual(["proc.output"]);
    expect(b).toEqual(["proc.output"]);
  });
});

describe("serve", () => {
  it("attaches a project and returns the config", async () => {
    const { link, lines } = pair();
    const core = fakeCore();
    serve(core, link);
    link.feed('{"id":1,"method":"project.attach","params":{"projectId":"p"}}\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(core.attached).toHaveLength(1);
    expect(lines().find((l) => l.id === 1)).toMatchObject({ result: { protocol: 1 } });
  });

  it("refuses an incompatible protocol major", async () => {
    const { link, lines } = pair();
    serve(fakeCore(), link);
    link.feed('{"id":1,"method":"project.attach","params":{"projectId":"p","protocol":2}}\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(lines().find((l) => l.id === 1)).toMatchObject({ error: { message: expect.stringContaining("incompatible protocol 2") } });
  });

  it("attaches lazily when a request arrives for an unknown project", async () => {
    const { link } = pair();
    const core = fakeCore();
    serve(core, link);
    link.feed('{"id":1,"method":"chat.send","params":{"projectId":"p","text":"hi"}}\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(core.attached.map((a) => a.projectId)).toEqual(["p"]);
    expect(core.calls).toEqual([{ method: "chat.send", params: { projectId: "p", text: "hi" } }]);
  });

  it("forwards host requests to the remote host", async () => {
    const { link, lines } = pair();
    serve(fakeCore(), link);
    const host = remoteHost(link);
    const p = host.files.read("a.ts");
    const req = lines().find((l) => l.method === "host.files.read");
    expect(req).toMatchObject({ params: { path: "a.ts" } });
    link.feed(`${JSON.stringify({ id: req!.id, result: { content: "x" } })}\n`);
    expect(await p).toEqual({ content: "x" });
  });
});

describe("remoteHost", () => {
  it("maps every HostPort member onto host.* methods", async () => {
    const { link, lines } = pair();
    const host = remoteHost(link);
    const calls: Promise<unknown>[] = [
      host.secrets.get("r"),
      host.secrets.set("r", "v"),
      host.files.exists("a"),
      host.files.list("."),
      host.files.stat("a"),
      host.files.writeAtomic("a", "c"),
      host.files.appendLine("a", "l"),
      host.files.readLines("a"),
      host.files.delete("a"),
      host.files.readBack("a"),
      host.diff.preview("a", "b"),
      host.diag.problems(),
      host.workspace.roots(),
      host.workspace.stateDir(),
      host.workspace.trusted(),
    ];
    for (const p of calls) p.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const methods = lines().map((l) => l.method).filter(Boolean);
    expect(methods).toEqual([
      "host.secrets.get",
      "host.secrets.set",
      "host.files.exists",
      "host.files.list",
      "host.files.stat",
      "host.files.writeAtomic",
      "host.files.appendLine",
      "host.files.readLines",
      "host.files.delete",
      "host.files.readBack",
      "host.diff.preview",
      "host.diag.problems",
      "host.workspace.roots",
      "host.workspace.stateDir",
      "host.workspace.trusted",
    ]);
    expect(lines().some((l) => l.method === "log" || l.method === undefined)).toBe(false);
    host.log("hello");
    expect(lines().at(-1)).toMatchObject({ method: "log", params: { line: "hello" } });
  });

  it("streams process output and resolves done on exit", async () => {
    const { link, lines } = pair();
    const host = remoteHost(link);
    const chunks: string[] = [];
    const proc = host.proc.run(["node", "-v"], { cwd: "/p", onData: (d) => chunks.push(d) });
    await new Promise((r) => setTimeout(r, 5));
    const start = lines().find((l) => l.method === "host.proc.run")!;
    const handle = (start.params as { handle: string }).handle;
    link.feed(`${JSON.stringify({ method: "proc.output", params: { handle, data: "v22" } })}\n`);
    link.feed(`${JSON.stringify({ method: "proc.exit", params: { handle, code: 0 } })}\n`);
    expect(await proc.done).toEqual({ code: 0 });
    expect(chunks).toEqual(["v22"]);
    proc.cancel();
    expect(lines().at(-1)).toMatchObject({ method: "proc.cancel", params: { handle } });
  });

  it("resolves done when the process cannot be started", async () => {
    const { link, lines } = pair();
    const proc = remoteHost(link).proc.run(["nope"], { cwd: "/p", onData: () => {} });
    const start = lines().find((l) => l.method === "host.proc.run")!;
    link.feed(`${JSON.stringify({ id: start.id, error: { message: "no such binary" } })}\n`);
    expect(await proc.done).toEqual({ code: -1 });
  });
});

describe("remoteConfigStore", () => {
  it("reads config files and skills through the host", async () => {
    const { host } = fakeHost({
      "/cfg/channels.yaml": "version: 1\nitems: []\n",
      "/cfg/skills/tdd.md": "---\nid: tdd\n---\nbody",
      "/cfg/skills/notes.txt": "ignored",
    });
    const store = remoteConfigStore(host, { current: "/cfg" });
    const layer = await store.read();
    expect(layer["channels.yaml"]).toContain("items: []");
    expect(layer["skills/tdd.md"]).toContain("body");
    expect(layer["skills/notes.txt"]).toBeUndefined();
    expect(layer["agents.yaml"]).toBeUndefined();
  });

  it("returns an empty layer before the host names a config dir", async () => {
    const { host } = fakeHost();
    expect(await remoteConfigStore(host, {}).read()).toEqual({});
  });

  it("writes and deletes through the host", async () => {
    const { host, files } = fakeHost({ "/cfg/roles.yaml": "old" });
    const store = remoteConfigStore(host, { current: "/cfg" });
    await store.write!("roles.yaml", "new");
    expect(files["/cfg/roles.yaml"]).toBe("new");
    await store.delete!("roles.yaml");
    expect(files["/cfg/roles.yaml"]).toBeUndefined();
  });
});
