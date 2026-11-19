import type { FilesPort } from "@stewart/kernel";
import { questionPrompt } from "@stewart/interaction";
import type { SlashCommand } from "../types.js";

const AGENTS_STUB =
  "# AGENTS\n\nNotes for AI assistants working on this project. To be filled in by /init.\n\n" +
  "Durable project memory lives in `docs/ai_docs/` — read `ARCHITECTURE.md`, `COMMANDS.md` and " +
  "`GOTCHAS.md` before making changes; append to `DECISIONS.md`, `PROGRESS.md` and `EVENTS.md` as work lands.\n";

const INIT_FILES: [string, string][] = [
  ["AGENTS.md", AGENTS_STUB],
  [
    "docs/ai_docs/ARCHITECTURE.md",
    "# Architecture\n\nModules, run paths and wiring as actually built. Confirm from code; update in the same change as structural edits.\n",
  ],
  [
    "docs/ai_docs/COMMANDS.md",
    "# Commands\n\nBuild, test, lint and run commands confirmed to work in this project.\n",
  ],
  [
    "docs/ai_docs/DECISIONS.md",
    "# Decisions\n\nDesign choices made and alternatives rejected, so they are not re-litigated. Newest first.\n",
  ],
  [
    "docs/ai_docs/PROGRESS.md",
    "# Progress\n\nMilestone and task status: what is done, pending and blocked.\n",
  ],
  [
    "docs/ai_docs/EVENTS.md",
    "# Events\n\nDated log of notable occurrences: incidents, releases, big merges, config changes — what happened and how it was resolved.\n",
  ],
  [
    "docs/ai_docs/GOTCHAS.md",
    "# Gotchas\n\nTraps and known issues discovered the hard way: version conflicts, flaky tests, things not to touch.\n",
  ],
  [
    "docs/ai_docs/MEMORY.md",
    "# Project memory\n\nDurable project facts confirmed by AI sessions that do not fit the files above.\n",
  ],
];

export const INIT_QUESTION = "AGENTS.md and docs/ai_docs are in place. Analyse the project and fill them in now?";
export const INIT_INVESTIGATE = "Analyse and fill them in";
export const INIT_STOP = "Stop here for now";

export const INIT_PROMPT =
  "Inspect this project (layout, build files, README, main source and test directories) " +
  "with the read-only tools, then update AGENTS.md at the project root and the memory files under " +
  "docs/ai_docs/ (ARCHITECTURE, COMMANDS, DECISIONS, PROGRESS, EVENTS, GOTCHAS — each file's header says " +
  "what belongs in it) with EditFile or WriteFile. Keep them brief: a one-line description, the build/test/run " +
  "commands, the code layout, and the conventions you can confirm from the code. If a file is still " +
  "accurate, leave it alone. Do not guess commands you could not confirm.";

export async function ensureInitFiles(files: FilesPort["files"]): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const [rel, stub] of INIT_FILES) {
    if (await files.exists(rel)) existing.push(rel);
    else {
      await files.writeAtomic(rel, stub);
      created.push(rel);
    }
  }
  return { created, existing };
}

function initSummary(res: { created: string[]; existing: string[] }): string {
  const parts: string[] = [];
  if (res.created.length) parts.push(`created: ${res.created.join(", ")}`);
  if (res.existing.length) parts.push(`already present: ${res.existing.join(", ")}`);
  return `Init: ${parts.join(" · ") || "nothing found"}`;
}

export const initCommand: SlashCommand = {
  name: "init",
  argHint: "",
  description: "Create AGENTS.md and docs/ai_docs memory files, then optionally analyse the project",
  async run(ctx) {
    try {
      ctx.say(initSummary(await ensureInitFiles(ctx.files)));
    } catch (e) {
      ctx.say(`Init failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    void ctx.interaction
      .ask(questionPrompt("ask_user", INIT_QUESTION, [INIT_INVESTIGATE, INIT_STOP]), { runId: ctx.ids.next("slash") })
      .then(async (outcome) => {
        if (outcome.kind !== "answered" || outcome.value !== INIT_INVESTIGATE) {
          ctx.say("Init: stopped here.");
          return;
        }
        try {
          await ctx.session.send(ctx.sessionId, INIT_PROMPT);
        } catch (e) {
          ctx.say(`Init: could not start the analysis: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
  },
};
