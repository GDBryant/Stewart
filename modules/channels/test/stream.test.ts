import { describe, expect, it } from "vitest";
import { StreamAccumulator, postForStream, type WireDelta } from "../src/stream.js";
import { ChannelError } from "../src/types.js";
import { fakeFetcher } from "@stewart/kernel";
import type { Fetcher } from "@stewart/kernel";

const applyAll = (acc: StreamAccumulator, deltas: WireDelta[]) => deltas.flatMap((d) => acc.apply(d));

describe("StreamAccumulator", () => {
  it("passes text and reasoning through immediately", () => {
    const acc = new StreamAccumulator();
    expect(applyAll(acc, [{ t: "text", text: "hi" }, { t: "reasoning", text: "think" }])).toEqual([
      { kind: "text", text: "hi" },
      { kind: "reasoning", text: "think" },
    ]);
  });

  it("merges tool fragments by index and emits parsed calls on finish", () => {
    const acc = new StreamAccumulator();
    applyAll(acc, [
      { t: "tool_fragment", index: 0, id: "c1", name: "Edit", args: '{"pa' },
      { t: "tool_fragment", index: 0, args: 'th":"x"}' },
    ]);
    const fin = acc.finish();
    const tc = fin.find((e) => e.kind === "tool_calls") as { calls: { id: string; name: string; arguments: { path: string } }[] } | undefined;
    expect(tc?.calls[0]).toMatchObject({ id: "c1", name: "Edit", arguments: { path: "x" } });
    expect(fin.at(-1)?.kind).toBe("done");
  });

  it("drops unparseable tool args (fail closed)", () => {
    const acc = new StreamAccumulator();
    applyAll(acc, [{ t: "tool_fragment", index: 0, name: "Bad", args: "{not json" }]);
    const fin = acc.finish();
    const tc = fin.find((e) => e.kind === "tool_calls") as { calls: { arguments: Record<string, unknown> }[] } | undefined;
    expect(tc?.calls[0].arguments).toEqual({});
  });

  it("tracks usage, cost and truncation into the done event", () => {
    const acc = new StreamAccumulator();
    applyAll(acc, [
      { t: "usage", usage: { in: 3, out: 2 }, costUsd: 0.01 },
      { t: "truncated" },
    ]);
    const done = acc.finish().at(-1) as { kind: string; usage?: { in: number }; costUsd?: number; truncated?: boolean };
    expect(done).toMatchObject({ kind: "done", usage: { in: 3, out: 2 }, costUsd: 0.01, truncated: true });
  });

  it("emits complete tool_calls before done", () => {
    const acc = new StreamAccumulator();
    applyAll(acc, [{ t: "tool_calls", calls: [{ name: "Read", arguments: { path: "a" } }] }]);
    const fin = acc.finish();
    expect(fin[0]).toMatchObject({ kind: "tool_calls", calls: [{ id: "call_0", name: "Read" }] });
  });
});

describe("postForStream", () => {
  const deps = (fetcher: Fetcher) => ({ fetcher });
  const init = { headers: {}, signal: new AbortController().signal, body: "{}" };
  const describe = (status: number, body: string) => new ChannelError(`err ${status}: ${body}`, status);

  it("returns the body on 200", async () => {
    const { fetcher } = fakeFetcher([{ body: "data: x" }]);
    const body = await postForStream({ deps: deps(fetcher), provider: "p", model: "m" }, "http://x", init, describe);

    expect(await new Response(body).text()).toBe("data: x\n");
  });

  it("throws ChannelError with retry-after on 429", async () => {
    const { fetcher } = fakeFetcher([{ status: 429, body: "slow down", headers: { "retry-after": "3" } }]);
    await expect(postForStream({ deps: deps(fetcher), provider: "p", model: "m" }, "http://x", init, describe)).rejects.toMatchObject({ status: 429, retryAfterMs: 3000 });
  });

  it("delegates non-200 errors to describeError", async () => {
    const { fetcher } = fakeFetcher([{ status: 500, body: "boom" }]);
    await expect(postForStream({ deps: deps(fetcher), provider: "p", model: "m" }, "http://x", init, describe)).rejects.toThrow("err 500: boom");
  });

  it("rethrows connection failures", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("conn refused");
    };
    await expect(postForStream({ deps: deps(fetcher), provider: "p", model: "m" }, "http://x", init, describe)).rejects.toThrow("conn refused");
  });

  it("throws on empty body", async () => {
    const fetcher: Fetcher = async () => ({ status: 200, headers: {}, body: null });
    await expect(postForStream({ deps: deps(fetcher), provider: "p", model: "m" }, "http://x", init, describe)).rejects.toThrow("empty response body");
  });
});
