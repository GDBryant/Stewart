import { describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import { EventBus } from "../src/events.js";
import { mediaTypeFor } from "../src/mime.js";
import { err, fromThrowable, isErr, ok, StewartError } from "../src/result.js";
import { counterIds, nodeFetch, systemClock } from "../src/ports.js";
import { collect, fakeFetcher, fakeHost, streamOf } from "../src/testing.js";
import type { RunEvent } from "@stewart/protocol";

describe("EventBus", () => {
  const delta = (text: string): RunEvent => ({ kind: "text_delta", runId: "r", text, seq: 0 } as RunEvent);

  it("coalesces deltas into frames and flushes before non-delta events", async () => {
    const out: RunEvent[] = [];
    const bus = new EventBus((ev) => out.push(ev), 10);
    bus.emit(delta("a"));
    bus.emit(delta("b"));
    bus.emit({ kind: "run.finished", runId: "r", status: "done" } as RunEvent);
    expect(out[0]).toMatchObject({ kind: "text_delta", text: "ab" });
    expect(out[1]).toMatchObject({ kind: "run.finished" });
    bus.emit(delta("c"));
    await new Promise((r) => setTimeout(r, 30));
    expect(out.at(-1)).toMatchObject({ kind: "text_delta", text: "c" });
    bus.flush();
  });

  it("keeps deltas for different runs separate and notifies subscribers", async () => {
    const out: RunEvent[] = [];
    const bus = new EventBus((ev) => out.push(ev), 5);
    const seen: RunEvent[] = [];
    const off = bus.subscribe((ev) => void seen.push(ev));
    bus.emit(delta("x"));
    bus.emit({ kind: "text_delta", runId: "r2", text: "y", seq: 0 } as RunEvent);
    bus.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(out.filter((e) => e.kind === "text_delta")).toHaveLength(2);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    off();
    bus.emit({ kind: "run.finished", runId: "r", status: "done" } as RunEvent);
    await new Promise((r) => setTimeout(r, 0));
    const before = seen.length;
    bus.subscribe(() => {
      throw new Error("sub blew up");
    });
    bus.emit({ kind: "run.finished", runId: "r", status: "done" } as RunEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBe(before);
  });
});

describe("mediaTypeFor", () => {
  it("maps known extensions and returns undefined otherwise", () => {
    expect(mediaTypeFor("a.png")).toBe("image/png");
    expect(mediaTypeFor("b.JPG")).toBe("image/jpeg");
    expect(mediaTypeFor("c.txt")).toBeUndefined();
  });
});

describe("systemClock / counterIds / nodeFetch", () => {
  it("clock nows, timers fire and cancel", async () => {
    expect(systemClock.now()).toBeGreaterThan(0);
    let fired = false;
    systemClock.setTimeout(() => (fired = true), 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(true);
    let fired2 = false;
    const t = systemClock.setTimeout(() => (fired2 = true), 5);
    t.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired2).toBe(false);
  });

  it("counterIds produces sequential ids", () => {
    const ids = counterIds();
    expect(ids.next("run")).toBe("run-1");
    expect(ids.next("run")).toBe("run-2");
    expect(counterIds().next("x")).toBe("x-1");
  });

  it("nodeFetch rejects on unreachable hosts and resolves on real servers", async () => {
    await expect(nodeFetch("http://127.0.0.1:1/", {})).rejects.toThrow();
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "X-Test": "yes", "Content-Type": "text/plain" });
      res.end("hello");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const r = await nodeFetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      expect(r.status).toBe(200);
      expect(r.headers["x-test"]).toBe("yes");
      expect(r.headers["content-type"]).toContain("text/plain");
      expect(await new Response(r.body).text()).toBe("hello");
    } finally {
      srv.close();
    }
  });
});

describe("result helpers", () => {
  it("ok/err/isErr round-trip with StewartError fields", () => {
    const good = ok(42);
    expect(good).toEqual({ ok: true, value: 42 });
    expect(isErr(good)).toBe(false);
    const bad = err("E_TEST", "boom", new Error("why"));
    expect(isErr(bad)).toBe(true);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(StewartError);
      expect(bad.error.name).toBe("StewartError");
      expect(bad.error.code).toBe("E_TEST");
      expect(bad.error.message).toBe("boom");
      expect(bad.error.cause).toBeInstanceOf(Error);
    }
  });

  it("fromThrowable returns ok or wraps Error and non-Error throws", () => {
    expect(fromThrowable("E", () => "v")).toEqual({ ok: true, value: "v" });
    const wrapped = fromThrowable("E_WRAP", () => {
      throw new Error("inner");
    });
    expect(isErr(wrapped)).toBe(true);
    if (!wrapped.ok) {
      expect(wrapped.error.code).toBe("E_WRAP");
      expect(wrapped.error.message).toBe("inner");
      expect(wrapped.error.cause).toBeInstanceOf(Error);
    }
    const plain = fromThrowable("E_STR", () => {
      throw "plain";
    });
    expect(isErr(plain)).toBe(true);
    if (!plain.ok) {
      expect(plain.error.message).toBe("plain");
      expect(plain.error.cause).toBe("plain");
    }
  });
});

describe("fakeHost", () => {
  it("reads, edits, lists, stats and tracks edits", async () => {
    const { host, files, edits } = fakeHost({ "a/b.ts": "hello", "a/c.ts": "x" });
    expect(await host.files.exists("a/b.ts")).toBe(true);
    expect(await host.files.exists("a")).toBe(true);
    expect(await host.files.exists("nope")).toBe(false);
    expect((await host.files.read("a/b.ts")).content).toBe("hello");
    await expect(host.files.read("nope")).rejects.toThrow(/not found/);
    await expect(host.files.stat("nope")).rejects.toThrow();
    expect((await host.files.stat("a/b.ts")).size).toBe(5);
    expect((await host.files.list("a")).sort()).toEqual(["a/b.ts", "a/c.ts"]);
    await host.files.edit({ path: "a/b.ts", edits: [{ oldText: "hello", newText: "bye" }] });
    expect(files["a/b.ts"]).toBe("bye");
    await host.files.edit({ path: "a/c.ts", content: "new" });
    expect(edits).toHaveLength(2);
    expect(await host.files.readBack("a/c.ts")).toBe("new");
    await host.files.writeAtomic("d.txt", "w");
    await host.files.appendLine("d.txt", "l2");
    expect(await host.files.readLines("d.txt")).toEqual(["w", "l2"]);
    await host.files.delete("d.txt");
    expect(await host.files.exists("d.txt")).toBe(false);
  });

  it("round-trips binary content via writeBinary/readBinary", async () => {
    const { host } = fakeHost();
    await host.files.writeBinary("img.png", "aGk=");
    expect((await host.files.readBinary("img.png")).base64).toBe("aGk=");
    const { host: h2 } = fakeHost({ "raw.bin": "abc" });
    expect((await h2.files.readBinary("raw.bin")).base64).toBe(Buffer.from("abc").toString("base64"));
  });

  it("runs scripted procs, reports kills, never-done mode", async () => {
    const { host, procs, setProcHandler } = fakeHost();
    const p = host.proc.run(["echo", "hi"], { cwd: "/w", onData: () => {} });
    expect(await p.done).toEqual({ code: 0 });
    expect(procs[0].argv).toEqual(["echo", "hi"]);
    setProcHandler((_a, onData) => {
      onData("out");
      return { code: 7 };
    });
    let got = "";
    const p2 = host.proc.run(["x"], { cwd: "/w", onData: (d) => (got += d) });
    expect(got).toBe("out");
    expect(await p2.done).toEqual({ code: 7 });
    setProcHandler(() => "never");
    const p3 = host.proc.run(["sleep"], { cwd: "/w", onData: () => {} });
    await p3.killTree();
    expect(await p3.done).toEqual({ code: -1 });
    expect(procs.at(-1)?.killed).toBe(true);
  });

  it("exposes problems, selection, workspace, secrets and logs", async () => {
    const { host, setProblems, setSelection } = fakeHost({}, { roots: ["/r"], trusted: false });
    setProblems([{ path: "a", line: 1, message: "m", severity: "error" }]);
    expect(await host.diag.problems()).toHaveLength(1);
    setSelection({ path: "f", text: "t", startLine: 1, endLine: 2 });
    expect((await host.editor.selection())?.path).toBe("f");
    expect(await host.workspace.roots()).toEqual(["/r"]);
    expect(await host.workspace.trusted()).toBe(false);
    expect(await host.workspace.stateDir()).toBe("/tmp/st");
    await host.secrets.set("k", "v");
    expect(await host.secrets.get("k")).toBeUndefined();
    await host.secrets.delete("k");
    await host.diff.preview("p", "c");
    host.log("line");
  });
});

describe("fakeFetcher / streamOf / collect", () => {
  it("serves scripted responses, records calls, clamps to last spec", async () => {
    const { fetcher, calls } = fakeFetcher([{ status: 201, body: "one", headers: { a: "b" } }, { body: ["l1", "l2"] }]);
    const r1 = await fetcher("u1", { body: "req" });
    expect(r1.status).toBe(201);
    const t1 = await new Response(r1.body!).text();
    expect(t1).toBe("one\n");
    const r2 = await fetcher("u2", {});
    expect(await new Response(r2.body!).text()).toBe("l1\nl2\n");
    const r3 = await fetcher("u3", {});
    expect(r3.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["u1", "u2", "u3"]);
  });

  it("streamOf emits chunked lines and collect gathers an async iterable", async () => {
    const chunks = await collect(streamOf(["a", "b"]).getReader ? (async function* () {
      const r = streamOf(["a", "b"]).getReader();
      for (;;) {
        const { value, done } = await r.read();
        if (done) return;
        yield value;
      }
    })() : []);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
