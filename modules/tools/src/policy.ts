import type { RoleDef } from "@stewart/config";
import type { ToolPreview } from "@stewart/permissions";
import { matchGlob } from "@stewart/roles-skills";
import { deniedDirReason } from "./projectPaths.js";
import { splitShellPrograms } from "@stewart/permissions";

/** File-writing tools whose `path` arg is checked against role writePaths. */
export const PATH_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);

const READONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "find", "grep", "rg", "git",
  "pwd", "which", "echo", "uname", "printenv", "diff", "du", "df",
  "sort", "uniq", "cut", "tr", "basename", "dirname", "date", "tree",
]);
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe",
]);
const HARMLESS_REDIRECTS = /(?:2>&1|(?:2|&)?>\s*\/dev\/null)(?=\s|$|[|;&])/g;
const VERSION_PROBE = /^\s*[A-Za-z0-9_.+-]+\s+(?:--version|-v)\s*$/;
const TEST_RUNNER = /\b(vitest|jest|pytest|mocha)\b|\b(pnpm|npm|yarn|npx|gradlew?)\b.*\btest/;
const WRITE_FLAGS: Record<string, RegExp> = {
  sort: /^(-[A-Za-z]*o|--output)/,
  tree: /^-o/,
  date: /^(-s|--set)/,
};

function dropProbes(command: string): string | null {
  const parts = command.split(/(\|\||&&|[|;&\n])/);
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (!seg.trim()) continue;
    if (VERSION_PROBE.test(seg) && parts[i - 1] !== "|") continue;
    keep.push(seg);
  }
  return keep.length ? keep.join(";") : null;
}

function checkReadOnlySegment(seg: string, command: string, fail: (what: string) => never): void {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "git") {
    const sub = words.slice(1).find((w) => !w.startsWith("-"));
    if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) fail(`git subcommand '${sub ?? ""}'`);
  }
  const prog = words[0]?.split(/[\\/]/).pop() ?? "";
  const flag = WRITE_FLAGS[prog];
  if (flag && words.some((w) => flag.test(w))) fail(`command '${command}'`);
  if (prog === "uniq" && words.slice(1).filter((w) => !w.startsWith("-")).length > 1) fail(`command '${command}'`);
}

export function checkReadOnlyCommand(command: string, roleId: string): void {
  const fail = (what: string): never => {
    const hint = what.startsWith("command ") && TEST_RUNNER.test(command) ? "; test runners write caches: delegate to tester" : "";
    throw new Error(`${what} is not allowed for read-only role ${roleId}${hint}`);
  };
  const stripped = command.replace(HARMLESS_REDIRECTS, "");
  if (/[><]/.test(stripped)) fail(`command '${command}'`);
  const rest = dropProbes(stripped);
  if (rest === null) return;
  const progs = splitShellPrograms(rest);
  if (!progs || !progs.every((p) => READONLY_PROGRAMS.has(p))) fail(`command '${command}'`);
  for (const seg of rest.split(/[|;&\n]+/)) checkReadOnlySegment(seg, command, fail);
}

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);

/** True when the role's tool list has entries but no write tools. */
export function roleIsReadOnly(role: RoleDef): boolean {
  return role.tools.length > 0 && !role.tools.some((t) => WRITE_TOOLS.has(t));
}


/** One action the role policy judges: a file write, a shell command, or anything else. */
export type Action = { kind: "write"; path: string } | { kind: "command"; command: string } | { kind: "other" };
export type Decision = { allow: true } | { allow: false; reason: string };

/** The action a tool preview describes. */
export function actionOf(preview: ToolPreview | null): Action {
  if (preview?.kind === "file") return { kind: "write", path: preview.path };
  if (preview?.kind === "command") return { kind: "command", command: preview.command };
  return { kind: "other" };
}

function denyWrite(role: RoleDef, path: string): string | null {
  if (path.startsWith("/") || path.startsWith("..")) return `path '${path}' is outside the project`;
  const denied = deniedDirReason(path);
  if (denied) return denied;
  if (roleIsReadOnly(role)) return `read-only role '${role.id}' cannot edit files`;
  if (role.writePaths.length && !role.writePaths.some((g) => matchGlob(g, path))) return `path '${path}' is outside this role's writePaths`;
  return null;
}

function denyCommand(role: RoleDef, command: string): string | null {
  if (role.tools.length && !role.tools.includes("RunTerminal")) return `role '${role.id}' has no RunTerminal tool`;
  if (!roleIsReadOnly(role)) return null;
  try {
    checkReadOnlyCommand(command, role.id);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The one role-policy decision: every rule about what a role may do lives here. */
export function decide(role: RoleDef, action: Action): Decision {
  const reason =
    action.kind === "write" ? denyWrite(role, action.path) : action.kind === "command" ? denyCommand(role, action.command) : null;
  return reason ? { allow: false, reason } : { allow: true };
}
