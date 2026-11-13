import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { agentsToQualify, formatQualification, qualifyConfig, stripQualified } from "../src/qualify.js";
import { PROJECT_ID, type RunOpts } from "../src/runner.js";
import type { Workspace } from "../src/workspace.js";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "evals-qual-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const CHANNELS = `version: 1
items:
  - id: local
    type: ollama
    modelCaps:
      small:
        numCtx: 8192
        qualified:
          agent: { passed: true, at: 1, version: 1 }
      big:
        qualified:
          agent: { passed: true, at: 1, version: 1 }
  - id: bare
    type: openai-compatible
`;
const AGENTS = `version: 1
items:
  - { id: a-small, channel: local, model: small }
  - { id: a-big, channel: local, model: big }
  - { id: a-big-again, channel: local, model: big }
  - { id: a-unused, channel: bare, model: x }
`;
const ROLES = `version: 1
items:
  - { id: lead, enabled: true, agent: a-small, chain: [a-small, a-big, a-big-again] }
  - { id: off, enabled: false, agent: a-unused }
`;

async function configDir(files: Record<string, string>): Promise<string> {
  const dir = await tmp();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

const OPTS: RunOpts = { config: "/unused", disableLead: false, keep: "never" };

describe("stripQualified", () => {
  it("removes every qualified record and keeps other caps", async () => {
    const dir = await configDir({ "channels.yaml": CHANNELS });
    expect(await stripQualified(dir)).toBe(2);
    const doc = parse(await readFile(join(dir, "channels.yaml"), "utf8"));
    expect(doc.items[0].modelCaps.small).toEqual({ numCtx: 8192 });
    expect(doc.items[0].modelCaps.big).toEqual({});
    expect(await readFile(join(dir, "channels.yaml"), "utf8")).not.toContain("qualified");
  });

  it("leaves a file without records untouched and tolerates a missing file", async () => {
    const text = "version: 1\nitems:\n  - id: bare\n";
    const dir = await configDir({ "channels.yaml": text });
    expect(await stripQualified(dir)).toBe(0);
    expect(await readFile(join(dir, "channels.yaml"), "utf8")).toBe(text);
    expect(await stripQualified(await tmp())).toBe(0);
  });
});

describe("agentsToQualify", () => {
  it("picks agents bound by enabled roles, once per channel/model", async () => {
    const dir = await configDir({ "agents.yaml": AGENTS, "roles.yaml": ROLES });
    expect((await agentsToQualify(dir)).map((a) => a.id)).toEqual(["a-small", "a-big"]);
  });

  it("picks every agent when no role binds one, and none without agents", async () => {
    const dir = await configDir({ "agents.yaml": AGENTS });
    expect((await agentsToQualify(dir)).map((a) => a.id)).toEqual(["a-small", "a-big", "a-unused"]);
    expect(await agentsToQualify(await tmp())).toEqual([]);
  });
});

describe("qualifyConfig", () => {
  async function fakeWorkspace(): Promise<Workspace> {
    const dir = await tmp();
    const config = join(dir, "config");
    await mkdir(config);
    for (const [name, text] of Object.entries({ "channels.yaml": CHANNELS, "agents.yaml": AGENTS, "roles.yaml": ROLES })) await writeFile(join(config, name), text);
    return { dir, repo: join(dir, "repo"), state: join(dir, "state"), config };
  }

  it("strips old records before the core starts, qualifies each bound agent, and returns the copy", async () => {
    const ws = await fakeWorkspace();
    const calls: [string, Record<string, unknown>][] = [];
    let strippedAtStart = false;
    let removed: Workspace | undefined;
    const q = await qualifyConfig("/src", OPTS, {
      createWorkspace: async (id, src, disableLead) => {
        expect([id, src, disableLead]).toEqual(["qualify", "/src", false]);
        return ws;
      },
      startCore: async () => {
        strippedAtStart = !(await readFile(join(ws.config, "channels.yaml"), "utf8")).includes("qualified");
        const dispatch = async (m: string, p: Record<string, unknown>) => {
          calls.push([m, p]);
          if (p.model === "big") throw new Error("channel down");
          return { agent: { passed: false, detail: "context 8192 < 32000" }, function: { passed: true } };
        };
        return { log: {} as never, dispatch };
      },
      removeWorkspace: async (w) => void (removed = w),
    });
    expect(strippedAtStart).toBe(true);
    expect(calls).toEqual([
      ["setup.qualify", { projectId: PROJECT_ID, channel: "local", model: "small" }],
      ["setup.qualify", { projectId: PROJECT_ID, channel: "local", model: "big" }],
    ]);
    expect(q.config).toBe(ws.config);
    expect(q.rows).toEqual([
      { agent: "a-small", channel: "local", model: "small", agentQual: { passed: false, detail: "context 8192 < 32000" }, functionQual: { passed: true } },
      { agent: "a-big", channel: "local", model: "big", error: "channel down" },
    ]);
    await q.cleanup();
    expect(removed).toBe(ws);
  });

  it("records a non-Error throw and an empty reply", async () => {
    const ws = await fakeWorkspace();
    let n = 0;
    const q = await qualifyConfig("/src", OPTS, {
      createWorkspace: async () => ws,
      startCore: async () => ({
        log: {} as never,
        dispatch: async () => {
          if (n++ === 0) return undefined;
          throw "plain";
        },
      }),
      removeWorkspace: async () => {},
    });
    expect(q.rows[0]).toEqual({ agent: "a-small", channel: "local", model: "small", agentQual: undefined, functionQual: undefined });
    expect(q.rows[1].error).toBe("plain");
  });
});

describe("formatQualification", () => {
  it("prints pass, fail with detail, missing and error", () => {
    const text = formatQualification([
      { agent: "ok", channel: "c", model: "m", agentQual: { passed: true }, functionQual: { passed: false, detail: "wrong values" } },
      { agent: "bad", channel: "c", model: "m", agentQual: { passed: false } },
      { agent: "err", channel: "c", model: "m", error: "down" },
    ]);
    const [a, b, c] = text.split("\n");
    expect(a).toMatch(/^qualify ok\s+agent: pass; function: FAIL \(wrong values\)$/);
    expect(b).toMatch(/agent: FAIL \(no detail\); function: -$/);
    expect(c).toMatch(/agent: ERROR \(down\); function: -$/);
  });
});
