import { describe, expect, it } from "vitest";
import { OllamaAdapter, extractError, estimatePromptTokens, autoNumCtx } from "../src/ollama.js";
import { OpenAICompatAdapter } from "../src/openai.js";
import { ChannelRegistry, ManagedChannel } from "../src/registry.js";
import { ChannelError, type ChannelAdapter, type ChannelConfig, type ChatRequest } from "../src/types.js";
import { sseData } from "../src/stream.js";
import { makeTempDir, nodeSpawn, rmDir, writeTempFile } from "../src/claude/nodeSpawn.js";
import { collect, fakeFetcher } from "@stewart/kernel";

const oCfg: ChannelConfig = { id: "o", type: "ollama", enabled: true, baseUrl: "http://x/", maxParallel: 1 };
const aCfg: ChannelConfig = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1/", maxParallel: 4 };
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal, ...over });

describe("extractError", () => {
  it("prefers the JSON error field, then the raw body, then the fallback", () => {
    expect(extractError('{"error":"nope"}', "fb")).toBe("nope");
    expect(extractError('{"error":5}', "fb")).toBe('{"error":5}');
    expect(extractError("plain body", "fb")).toBe("plain body");
    expect(extractError("", "fb")).toBe("fb");
  });
});

describe("autoNumCtx / estimatePromptTokens", () => {
  it("leaves small prompts at default, sizes and caps large ones", () => {
    expect(autoNumCtx(100)).toBeUndefined();
    expect(autoNumCtx(5000)).toBe(8192);
    expect(autoNumCtx(50000)).toBe(32768);
    expect(autoNumCtx(5000, 2048)).toBe(2048);
    expect(estimatePromptTokens([{ a: 1 }], undefined)).toBeGreaterThan(0);
    expect(estimatePromptTokens([{ a: 1 }], [{ t: 1 }])).toBeGreaterThan(estimatePromptTokens([{ a: 1 }], undefined));
  });
});

describe("OllamaAdapter edge cases", () => {
  it("probeCaps maps capabilities and context length; non-200 throws", async () => {
    const { fetcher } = fakeFetcher([{ body: JSON.stringify({ capabilities: ["tools", "vision", "thinking"], model_info: { "general.context_length": 8192 } }) }]);
    const caps = await new OllamaAdapter({ fetcher }).probeCaps(oCfg, undefined, "m");
    expect(caps).toEqual({ tools: "native", vision: true, reasoning: true, contextTokens: 8192 });
    const { fetcher: f2 } = fakeFetcher([{ body: "{}" }]);
    const caps2 = await new OllamaAdapter({ fetcher: f2 }).probeCaps(oCfg, undefined, "m");
    expect(caps2).toEqual({ tools: "shim", vision: false, reasoning: false, contextTokens: undefined });
    const { fetcher: f3 } = fakeFetcher([{ status: 404, body: "not found" }]);
    await expect(new OllamaAdapter({ fetcher: f3 }).probeCaps(oCfg, undefined, "m")).rejects.toThrow(ChannelError);
  });

  it("listModels throws on non-200", async () => {
    const { fetcher } = fakeFetcher([{ status: 500, body: "x" }]);
    await expect(new OllamaAdapter({ fetcher }).listModels(oCfg)).rejects.toThrow(/api\/tags/);
  });

  it("serialises assistant tool calls, images and tool messages; surfaces thinking", async () => {
    const { fetcher, calls } = fakeFetcher([
      { body: ['{"message":{"content":"hi","thinking":"hmm"},"done":true,"prompt_eval_count":1,"eval_count":1}'] },
    ]);
    const r = req({
      messages: [
        { role: "user", content: "look", images: ["aGk="] },
        { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "ReadFile", arguments: { path: "a" } }] },
        { role: "tool", toolCallId: "c1", content: "data" },
      ],
    });
    const evs = await collect(new OllamaAdapter({ fetcher }).chat(oCfg, undefined, r));
    const body = JSON.parse(calls[0].body!);
    expect(body.messages[0].images).toEqual(["aGk="]);
    expect(body.messages[1].tool_calls[0].function.name).toBe("ReadFile");
    expect(body.messages[2]).toEqual({ role: "tool", content: "data" });
    expect(evs.some((e) => e.kind === "reasoning")).toBe(true);
  });

  it("throws on a non-object message field and maps 429 with retry-after", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"message":"oops","done":false}'] }]);
    await expect(collect(new OllamaAdapter({ fetcher }).chat(oCfg, undefined, req()))).rejects.toThrow(/invalid message/);
    const { fetcher: f2 } = fakeFetcher([{ status: 429, body: "slow", headers: { "retry-after": "2" } }]);
    await expect(collect(new OllamaAdapter({ fetcher: f2 }).chat(oCfg, undefined, req()))).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it("completes a stream that ended before done and honours abort", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"x"},"done":false}'] }]);
    const evs = await collect(new OllamaAdapter({ fetcher }).chat(oCfg, undefined, req()));
    expect(evs.at(-1)?.kind).toBe("done");
  });

  it("defaults baseUrl to localhost:11434 and strips trailing slashes", async () => {
    const { fetcher, calls } = fakeFetcher([{ body: '{"models":[]}' }]);
    await new OllamaAdapter({ fetcher }).listModels({ ...oCfg, baseUrl: undefined });
    expect(calls[0].url).toBe("http://localhost:11434/api/tags");
  });
});

describe("OpenAICompatAdapter edge cases", () => {
  it("probeCaps detects native/shim/none and throws on server errors", async () => {
    const { fetcher } = fakeFetcher([{ body: '{"choices":[{"message":{"tool_calls":[]}}]}' }]);
    expect((await new OpenAICompatAdapter({ fetcher }).probeCaps(aCfg, "k", "m")).tools).toBe("native");
    const { fetcher: f2 } = fakeFetcher([{ body: '{"choices":[{"message":{"content":"ok"}}]}' }]);
    expect((await new OpenAICompatAdapter({ fetcher: f2 }).probeCaps(aCfg, "k", "m")).tools).toBe("shim");
    const { fetcher: f3 } = fakeFetcher([{ status: 400, body: "tool use not supported" }]);
    expect((await new OpenAICompatAdapter({ fetcher: f3 }).probeCaps(aCfg, "k", "m")).tools).toBe("none");
    const { fetcher: f4 } = fakeFetcher([{ status: 500, body: "server error" }]);
    await expect(new OpenAICompatAdapter({ fetcher: f4 }).probeCaps(aCfg, "k", "m")).rejects.toThrow(ChannelError);
  });

  it("generateImage returns b64 or throws on errors and empty data", async () => {
    const ad = (f: ReturnType<typeof fakeFetcher>["fetcher"]) => new OpenAICompatAdapter({ fetcher: f });
    const { fetcher } = fakeFetcher([{ body: '{"data":[{"b64_json":"QUJD"}]}' }]);
    expect(await ad(fetcher).generateImage(aCfg, "k", "m", "p")).toEqual({ base64: "QUJD" });
    const { fetcher: f2 } = fakeFetcher([{ body: '{"data":[{}]}' }]);
    await expect(ad(f2).generateImage(aCfg, "k", "m", "p")).rejects.toThrow(/no data/);
    const { fetcher: f3 } = fakeFetcher([{ status: 400, body: "bad" }]);
    await expect(ad(f3).generateImage(aCfg, "k", "m", "p")).rejects.toThrow(/400/);
  });

  it("serialises tool messages, assistant calls and image blocks", async () => {
    const { fetcher, calls } = fakeFetcher([{ body: ["data: [DONE]"] }]);
    await collect(
      new OpenAICompatAdapter({ fetcher }).chat(aCfg, "k", req({
        messages: [
          { role: "user", content: "see", images: ["QUJD"] },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "T", arguments: { x: 1 } }] },
          { role: "tool", toolCallId: "c1", content: "out" },
        ],
      })),
    );
    const msgs = JSON.parse(calls[0].body!).messages;
    expect(msgs[0].content[1].image_url.url).toContain("data:image/png;base64,QUJD");
    expect(msgs[1].tool_calls[0].function.arguments).toBe('{"x":1}');
    expect(msgs[1].content).toBeNull();
    expect(msgs[2].tool_call_id).toBe("c1");
  });

  it("emits reasoning, truncation, cost and skips malformed chunks", async () => {
    const { fetcher } = fakeFetcher([
      {
        body: [
          "data: not-json",
          'data: {"choices":[{"delta":{"reasoning_content":"think","content":"hi"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"cost":0.5}}',
          "data: [DONE]",
        ],
      },
    ]);
    const evs = await collect(new OpenAICompatAdapter({ fetcher }).chat(aCfg, "k", req()));
    expect(evs.find((e) => e.kind === "reasoning")).toBeTruthy();
    const done = evs.at(-1);
    expect(done?.kind === "done" && done.truncated).toBe(true);
    expect(done?.kind === "done" && done.costUsd).toBe(0.5);
  });

  it("emits no tool_calls event when streamed args produce no named call", async () => {
    const { fetcher } = fakeFetcher([
      { body: ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"bad"}}]}}]}', "data: [DONE]"] },
    ]);
    const evs = await collect(new OpenAICompatAdapter({ fetcher }).chat(aCfg, "k", req()));
    expect(evs.some((e) => e.kind === "tool_calls")).toBe(false);
    expect(evs.at(-1)?.kind).toBe("done");
  });

  it("throws on a missing response body", async () => {
    const fetcher = async () => ({ status: 200, headers: {}, body: undefined as unknown as ReadableStream<Uint8Array> });
    await expect(collect(new OpenAICompatAdapter({ fetcher }).chat(aCfg, "k", req()))).rejects.toThrow(/empty response body/);
  });
});

describe("sseData", () => {
  it("skips non-data lines and empty data payloads", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(": comment\n\ndata:\ndata: x\ndata: [DONE]\ndata: never\n"));
        c.close();
      },
    });
    const out = await collect(sseData(body, new AbortController().signal, 1000));
    expect(out).toEqual(["x"]);
  });
});

describe("ChannelRegistry", () => {
  it("creates registered types and rejects unknown ones", () => {
    const r = new ChannelRegistry();
    const ad: ChannelAdapter = { type: "t", chat: async function* () {}, listModels: async () => [], probeCaps: async () => ({}) };
    r.register("t", () => ad);
    expect(r.types()).toEqual(["t"]);
    expect(r.create("t", {})).toBe(ad);
    expect(() => r.create("nope", {})).toThrow(/unknown channel type/);
  });
});

describe("ManagedChannel edge cases", () => {
  const cfg = { id: "c", type: "t", enabled: true, maxParallel: 1 };

  it("generateImage/priceList/probeCaps pass through or return undefined", async () => {
    const ad: ChannelAdapter = {
      type: "t",
      chat: async function* () {},
      listModels: async () => [],
      probeCaps: async () => ({ tools: "shim" }),
      priceList: async () => ({ m: { inPerMTok: 1, outPerMTok: 2 } }),
      generateImage: async () => ({ base64: "x" }),
    };
    const mc = new ManagedChannel(ad, cfg);
    expect(await mc.generateImage("m", "p")).toEqual({ base64: "x" });
    expect(await mc.priceList()).toEqual({ m: { inPerMTok: 1, outPerMTok: 2 } });
    expect(await mc.probeCaps("m")).toEqual({ tools: "shim" });
    const bare: ChannelAdapter = { type: "t", chat: async function* () {}, listModels: async () => [], probeCaps: async () => ({}) };
    const mc2 = new ManagedChannel(bare, cfg);
    expect(await mc2.generateImage("m", "p")).toBeUndefined();
    expect(await mc2.priceList()).toBeUndefined();
  });

  it("probeCaps failure counts toward the breaker and rethrows", async () => {
    const ad: ChannelAdapter = {
      type: "t",
      chat: async function* () {},
      listModels: async () => [],
      probeCaps: async () => {
        throw new ChannelError("down", 500);
      },
    };
    const mc = new ManagedChannel(ad, cfg);
    for (let i = 0; i < 5; i++) await expect(mc.probeCaps("m")).rejects.toThrow("down");
    expect(mc.health).toBe("unhealthy");
    await expect(collect(mc.chat(req()))).rejects.toThrow(/unhealthy/);
  });

  it("a stream that ends without done counts a failure; abort does not", async () => {
    let calls = 0;
    const ad: ChannelAdapter = {
      type: "t",
      chat: async function* () {
        calls++;
        yield { kind: "text", text: "partial" };
      },
      listModels: async () => [],
      probeCaps: async () => ({}),
    };
    const mc = new ManagedChannel(ad, cfg);
    for (let i = 0; i < 5; i++) await collect(mc.chat(req()));
    expect(mc.health).toBe("healthy");
    expect(calls).toBe(5);
    const aborted: ChannelAdapter = {
      type: "t",
      chat: async function* () {
        throw Object.assign(new Error("x"), { name: "AbortError" });
      },
      listModels: async () => [],
      probeCaps: async () => ({}),
    };
    const mc2 = new ManagedChannel(aborted, cfg);
    await expect(collect(mc2.chat(req()))).rejects.toThrow("x");
    expect(mc2.health).toBe("healthy");
  });

  it("backoff health after a 429", async () => {
    const ad: ChannelAdapter = {
      type: "t",
      chat: async function* () {
        throw new ChannelError("rate", 429, 60_000);
      },
      listModels: async () => [],
      probeCaps: async () => ({}),
    };
    const mc = new ManagedChannel(ad, cfg);
    await expect(collect(mc.chat(req()))).rejects.toThrow("rate");
    expect(mc.health).toBe("backoff");
  });
});

describe("nodeSpawn", () => {
  it("round-trips stdin/stdout and resolves done with the exit code", async () => {
    const proc = nodeSpawn([process.execPath, "-e", 'process.stdin.on("data",(d)=>{console.log("echo:"+String(d).trim());process.exit(3);})'], { cwd: "/tmp", env: {} });
    proc.stdin("hi\n");
    const linesOut: string[] = [];
    for await (const l of proc.stdout) linesOut.push(l);
    expect(linesOut).toEqual(["echo:hi"]);
    expect(await proc.done).toEqual({ code: 3 });
    expect(await proc.stderrText()).toBe("");
  });

  it("resolves code -1 for a missing binary", async () => {
    const proc = nodeSpawn(["definitely-not-a-real-binary-xyz"], { cwd: "/tmp", env: {} });
    for await (const _ of proc.stdout) void _;
    expect(await proc.done).toEqual({ code: -1 });
  });

  it("kill terminates a sleeping process", async () => {
    const proc = nodeSpawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd: "/tmp", env: {} });
    const reading = (async () => {
      for await (const _ of proc.stdout) void _;
    })();
    await proc.kill();
    await reading;
    const { code } = await proc.done;
    expect(code).not.toBe(0);
  });

  it("temp dir helpers create, write and remove", async () => {
    const dir = await makeTempDir();
    const f = await writeTempFile("stewart-test-", "content");
    expect(f).toContain("stewart-test-");
    await rmDir(dir);
    await rmDir(f.split("/").slice(0, -1).join("/"));
  });
});
