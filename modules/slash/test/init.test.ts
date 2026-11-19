import { describe, expect, it, vi } from "vitest";
import { runSlash } from "../src/api.js";
import { ensureInitFiles, INIT_INVESTIGATE, INIT_PROMPT, INIT_STOP } from "../src/api.js";
import { locals, makeDeps, questions, REGISTRY } from "./helpers.js";

describe("/init files", () => {
  it("creates AGENTS.md and the docs/ai_docs memory files when missing", async () => {
    const files: Record<string, string> = {};
    const { deps } = makeDeps(files);
    const res = await ensureInitFiles(deps.files);
    expect(res.created).toEqual([
      "AGENTS.md",
      "docs/ai_docs/ARCHITECTURE.md",
      "docs/ai_docs/COMMANDS.md",
      "docs/ai_docs/DECISIONS.md",
      "docs/ai_docs/PROGRESS.md",
      "docs/ai_docs/EVENTS.md",
      "docs/ai_docs/GOTCHAS.md",
      "docs/ai_docs/MEMORY.md",
    ]);
    expect(res.existing).toEqual([]);
    expect(files["AGENTS.md"]).toContain("docs/ai_docs/");
    expect(files["docs/ai_docs/ARCHITECTURE.md"]).toContain("as actually built");
    expect(files["docs/ai_docs/EVENTS.md"]).toContain("Dated log");
    expect(files["docs/ai_docs/MEMORY.md"]).toContain("# Project memory");
  });

  it("reports existing files without overwriting them", async () => {
    const files = { "AGENTS.md": "keep me" };
    const { deps } = makeDeps(files);
    const res = await ensureInitFiles(deps.files);
    expect(res.existing).toEqual(["AGENTS.md"]);
    expect(res.created).toHaveLength(7);
    expect(res.created).not.toContain("AGENTS.md");
    expect(files["AGENTS.md"]).toBe("keep me");
  });
});

describe("/init", () => {
  it("asks the user and sends the analysis prompt on investigate", async () => {
    const { deps, events, interaction, sent } = makeDeps();
    await runSlash(REGISTRY, deps, "/init", "s1");
    const [q] = questions(events);
    expect(q.options).toEqual([INIT_INVESTIGATE, INIT_STOP]);
    expect(locals(events)[0]).toContain("created: AGENTS.md, docs/ai_docs/ARCHITECTURE.md");
    interaction.resolveAnswer(q.questionId, INIT_INVESTIGATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ sessionId: "s1", text: INIT_PROMPT });
  });

  it("stops without sending a prompt when the user declines", async () => {
    const { deps, events, interaction, sent } = makeDeps();
    await runSlash(REGISTRY, deps, "/init");
    const [q] = questions(events);
    interaction.resolveAnswer(q.questionId, INIT_STOP);
    await vi.waitFor(() => expect(locals(events).some((t) => t.includes("stopped here"))).toBe(true));
    expect(sent).toHaveLength(0);
  });
});
