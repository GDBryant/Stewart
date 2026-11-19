import type { FilesPort, IdGen } from "@stewart/kernel";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { RunEvent } from "@stewart/protocol";

export interface SlashParsed {
  name: string;
  args: string;
}

/** `/name args` when [input] starts with a single `/`; `//` escapes to plain text (see [slashPlainText]). */
export function parseSlash(input: string): SlashParsed | null {
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  const body = input.slice(1);
  const ws = body.search(/\s/);
  const name = (ws < 0 ? body : body.slice(0, ws)).toLowerCase();
  if (!name) return null;
  return { name, args: ws < 0 ? "" : body.slice(ws).trim() };
}

/** Text to send for non-command input: a leading `//` sends a single `/`. */
export function slashPlainText(input: string): string {
  return input.startsWith("//") ? input.slice(1) : input;
}

export interface SlashDeps {
  ids: IdGen;
  /** Emits `chat.local` items into the chat view. */
  emit(ev: RunEvent): void;
  files: FilesPort["files"];
  interaction: Interaction;
  /** Sends [text] to the lead as a normal message in [sessionId]. */
  sendPrompt(sessionId: string | undefined, text: string): Promise<unknown>;
}

function local(deps: SlashDeps, text: string): void {
  deps.emit({ kind: "chat.local", runId: deps.ids.next("slash"), text });
}

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

export interface SlashCommand {
  name: string;
  argHint: string;
  description: string;
  run(deps: SlashDeps, args: string, sessionId?: string): Promise<void>;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    argHint: "",
    description: "List commands",
    async run(deps) {
      const lines = SLASH_COMMANDS.map((c) => {
        const usage = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
        return `- \`${usage}\` — ${c.description}`;
      });
      local(deps, `**Commands**\n${lines.join("\n")}\n\n\`//\` sends a literal leading slash.`);
    },
  },
  {
    name: "init",
    argHint: "",
    description: "Create AGENTS.md and docs/ai_docs memory files, then optionally analyse the project",
    async run(deps, _args, sessionId) {
      try {
        local(deps, initSummary(await ensureInitFiles(deps.files)));
      } catch (e) {
        local(deps, `Init failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      void deps.interaction
        .ask(questionPrompt("ask_user", INIT_QUESTION, [INIT_INVESTIGATE, INIT_STOP]), { runId: deps.ids.next("slash") })
        .then(async (outcome) => {
          if (outcome.kind !== "answered" || outcome.value !== INIT_INVESTIGATE) {
            local(deps, "Init: stopped here.");
            return;
          }
          try {
            await deps.sendPrompt(sessionId, INIT_PROMPT);
          } catch (e) {
            local(deps, `Init: could not start the analysis: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
    },
  },
];

/**
 * Runs a slash command; false when [input] is not a command (caller sends it as
 * a normal message). Unknown commands answer with a local hint, not a turn.
 */
export async function runSlash(deps: SlashDeps, input: string, sessionId?: string): Promise<boolean> {
  const parsed = parseSlash(input);
  if (!parsed) return false;
  const cmd = SLASH_COMMANDS.find((c) => c.name === parsed.name);
  if (!cmd) {
    local(deps, `Unknown command \`/${parsed.name}\` — type \`/help\``);
    return true;
  }
  await cmd.run(deps, parsed.args, sessionId);
  return true;
}
