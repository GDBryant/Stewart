import { describe, expect, it, vi } from "vitest";
import { counterIds, fakeHost, systemClock } from "@stewart/kernel";
import { Interaction } from "@stewart/interaction";
import type { RunEvent } from "@stewart/protocol";
import {
  ensureInitFiles,
  INIT_INVESTIGATE,
  INIT_PROMPT,
  INIT_STOP,
  parseSlash,
  runSlash,
  slashPlainText,
  type SlashDeps,
} from "../src/api.js";

function makeDeps(files: Record<string, string> = {}) {
  const events: RunEvent[] = [];
  const { host } = fakeHost(files);
  const interaction = new Interaction({ ids: counterIds(), clock: systemClock, bus: { emit: (e) => events.push(e) } });
  const sent: { sessionId?: string; text: string }[] = [];
  const deps: SlashDeps = {
    ids: counterIds(),
    emit: (e) => events.push(e),
    files: host.files,
    interaction,
    sendPrompt: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
  };
  return { deps, events, interaction, sent, files };
}

const locals = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { kind: "chat.local" }> => e.kind === "chat.local").map((e) => e.text);

const questions = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { kind: "ask_user" }> => e.kind === "ask_user");

describe("parseSlash", () => {
  it("parses name and args, lowercases the name", () => {
    expect(parseSlash("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlash("/INIT  foo bar ")).toEqual({ name: "init", args: "foo bar" });
  });

  it("returns null for plain text, double slash, and bare slash", () => {
    expect(parseSlash("hello /help")).toBeNull();
    expect(parseSlash("//literal")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/ ")).toBeNull();
  });
});

describe("slashPlainText", () => {
  it("strips one leading slash only", () => {
    expect(slashPlainText("//literal")).toBe("/literal");
    expect(slashPlainText("plain")).toBe("plain");
    expect(slashPlainText("/cmd")).toBe("/cmd");
  });
});

describe("runSlash", () => {
  it("returns false for non-commands", async () => {
    const { deps } = makeDeps();
    expect(await runSlash(deps, "fix the bug")).toBe(false);
    expect(await runSlash(deps, "//notacommand")).toBe(false);
  });

  it("/help emits a chat.local listing every command", async () => {
    const { deps, events } = makeDeps();
    expect(await runSlash(deps, "/help")).toBe(true);
    const [text] = locals(events);
    expect(text).toContain("Commands");
    expect(text).toContain("/help");
    expect(text).toContain("/init");
  });

  it("unknown command answers with a local hint, no prompt sent", async () => {
    const { deps, events, sent } = makeDeps();
    expect(await runSlash(deps, "/bogus")).toBe(true);
    expect(locals(events)[0]).toContain("Unknown command `/bogus`");
    expect(sent).toHaveLength(0);
  });
});

describe("/init", () => {
  it("creates AGENTS.md and docs/ai_docs/MEMORY.md when missing", async () => {
    const files: Record<string, string> = {};
    const { deps } = makeDeps(files);
    const res = await ensureInitFiles(deps.files);
    expect(res.created).toEqual(["AGENTS.md", "docs/ai_docs/MEMORY.md"]);
    expect(res.existing).toEqual([]);
    expect(files["AGENTS.md"]).toContain("# AGENTS");
    expect(files["docs/ai_docs/MEMORY.md"]).toContain("# Project memory");
  });

  it("reports existing files without overwriting them", async () => {
    const files = { "AGENTS.md": "keep me" };
    const { deps } = makeDeps(files);
    const res = await ensureInitFiles(deps.files);
    expect(res.existing).toEqual(["AGENTS.md"]);
    expect(res.created).toEqual(["docs/ai_docs/MEMORY.md"]);
    expect(files["AGENTS.md"]).toBe("keep me");
  });

  it("asks the user and sends the analysis prompt on investigate", async () => {
    const { deps, events, interaction, sent } = makeDeps();
    await runSlash(deps, "/init", "s1");
    const [q] = questions(events);
    expect(q.options).toEqual([INIT_INVESTIGATE, INIT_STOP]);
    expect(locals(events)[0]).toContain("created: AGENTS.md, docs/ai_docs/MEMORY.md");
    interaction.resolveAnswer(q.questionId, INIT_INVESTIGATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ sessionId: "s1", text: INIT_PROMPT });
  });

  it("stops without sending a prompt when the user declines", async () => {
    const { deps, events, interaction, sent } = makeDeps();
    await runSlash(deps, "/init");
    const [q] = questions(events);
    interaction.resolveAnswer(q.questionId, INIT_STOP);
    await vi.waitFor(() => expect(locals(events).some((t) => t.includes("stopped here"))).toBe(true));
    expect(sent).toHaveLength(0);
  });
});
