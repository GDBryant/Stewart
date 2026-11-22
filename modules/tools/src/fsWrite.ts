import type { Json, ToolSpec } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import { arg, optBool, schema, str, bool, ProjectTool } from "./toolBase.js";

export abstract class EditTool extends ProjectTool {
  requiresApproval = true;

  /** "file not found" plus the closest existing path (same basename after stripping a junk prefix/suffix). */
  protected async notFound(rel: string): Promise<Error> {
    const hint = await this.paths.suggest(rel);
    return new Error(`file not found: ${rel}${hint ? ` (did you mean ${hint}?)` : ""}`);
  }

  protected async currentText(rel: string): Promise<string | null> {
    if (!(await this.paths.exists(rel))) return null;
    const { content } = await this.paths.read(rel);
    return content;
  }

  /** Injectable for tests; the real host's disk write can lag (IntelliJ saves documents async). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Applies the previewed change; returns an optional note appended to the tool result. */
  protected async applyChange(rel: string, preview: ToolPreview | null): Promise<string | undefined> {
    const change = preview?.kind === "file" ? preview : null;
    if (!change) throw new Error("missing preview");
    const current = await this.currentText(rel);
    if ((current ?? null) !== change.before) {
      throw new Error(`file changed since preview: ${rel}`);
    }
    if (change.before === null) await this.host.files.writeAtomic(rel, change.after);
    else await this.host.files.edit({ path: rel, content: change.after });
    return this.verifyWrite(rel, change);
  }

  private async verifyWrite(rel: string, change: { before: string | null; after: string }): Promise<string | undefined> {
    const want = change.after.replace(/\r\n/g, "\n");
    let disk: string | undefined;
    let missing = true;
    for (const d of READBACK_DELAYS_MS) {
      if (d > 0) await this.sleep(d);
      const got = await this.host.files.readBack(rel).catch(() => undefined);
      if (got === undefined) continue;
      missing = false;
      disk = got.replace(/\r\n/g, "\n");
      if (disk === want) return undefined;
    }
    if (missing) throw new Error(`file missing after write: ${rel}; side effects uncertain`);
    if (loose(disk!) === loose(want)) return WHITESPACE_NOTE;
    if (change.before !== null && disk === change.before.replace(/\r\n/g, "\n")) {
      throw new Error(`write did not reach disk: ${rel}`);
    }
    throw new Error(`file content differs from approved change; side effects uncertain: ${rel}`);
  }
}

/** Read-back delays (ms) before each post-write verification attempt. */
const READBACK_DELAYS_MS = [0, 50, 100, 200, 400, 800];

const WHITESPACE_NOTE = " (saved with whitespace changes by the editor; re-read before editing it again)";

/** Line-end whitespace and a trailing newline at EOF are editor-applied, not a mismatch. */
function loose(s: string): string {
  return s.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

export class WriteFile extends EditTool {
  spec: ToolSpec = {
    name: "WriteFile",
    description: "Write a whole file",
    parameters: schema({ path: str, content: str }, ["path", "content"]),
  };

  async preview(args: Json): Promise<ToolPreview> {
    const rel = this.paths.resolve(arg(args, "path"));
    return { kind: "file", path: rel, before: await this.currentText(rel), after: arg(args, "content") };
  }

  async execute(args: Json, preview: ToolPreview | null): Promise<string> {
    const rel = this.paths.resolve(arg(args, "path"));
    const note = await this.applyChange(rel, preview);
    const lines = arg(args, "content").split("\n").length;
    return `wrote ${rel} (${lines} lines)${note ?? ""}`;
  }
}

export class EditFile extends EditTool {
  spec: ToolSpec = {
    name: "EditFile",
    description: "Replace text in a file",
    parameters: schema({ path: str, old_string: str, new_string: str, replace_all: bool }, ["path", "old_string", "new_string"]),
  };

  async preview(args: Json): Promise<ToolPreview> {
    const rel = this.paths.resolve(arg(args, "path"));
    const old = arg(args, "old_string");
    if (old === "") throw new Error("old_string must not be empty");
    const before = await this.currentText(rel);
    if (before === null) throw await this.notFound(rel);
    const occurrences = before.split(old).length - 1;
    if (occurrences === 0) throw new Error(`old_string not found in ${rel}`);
    const all = optBool(args, "replace_all");
    if (occurrences > 1 && !all) {
      throw new Error(`old_string matches ${occurrences} times in ${rel}; use replace_all or more context`);
    }
    const nw = arg(args, "new_string");
    const after = all ? before.split(old).join(nw) : before.replace(old, nw);
    return { kind: "file", path: rel, before, after };
  }

  async execute(args: Json, preview: ToolPreview | null): Promise<string> {
    const rel = this.paths.resolve(arg(args, "path"));
    const note = await this.applyChange(rel, preview);
    return `edited ${rel}${note ?? ""}`;
  }
}

type PatchHunk = { oldLines: string[]; newLines: string[] };

function addPatchLine(h: PatchHunk, line: string): void {
  if (line.startsWith("-")) {
    h.oldLines.push(line.slice(1));
    return;
  }
  if (line.startsWith("+")) {
    h.newLines.push(line.slice(1));
    return;
  }
  if (line.startsWith(" ")) {
    h.oldLines.push(line.slice(1));
    h.newLines.push(line.slice(1));
    return;
  }
  if (line === "\\ No newline at end of file" || line === "") return;
  h.oldLines.push(line);
  h.newLines.push(line);
}

function parsePatchHunks(lines: string[]): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { oldLines: [], newLines: [] };
      continue;
    }
    if (!current) continue;
    addPatchLine(current, line);
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyHunk(out: string, h: PatchHunk, rel: string): string {
  const target = h.oldLines.join("\n");
  const replacement = h.newLines.join("\n");
  if (target === "") return out ? `${out}\n${replacement}` : replacement;
  const idx = out.indexOf(target);
  if (idx < 0) throw new Error(`patch hunk failed to apply in ${rel}`);
  return out.slice(0, idx) + replacement + out.slice(idx + target.length);
}

export function applyUnifiedPatch(before: string, patch: string, rel: string): string {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks = parsePatchHunks(lines);
  if (hunks.length === 0) throw new Error(`invalid patch for ${rel}: no hunks found`);
  let out = before.replace(/\r\n/g, "\n");
  for (const h of hunks) out = applyHunk(out, h, rel);
  return out;
}

export class ApplyPatch extends EditTool {
  spec: ToolSpec = {
    name: "ApplyPatch",
    description: "Apply a unified diff patch to a file",
    parameters: schema({ path: str, patch: str }, ["path", "patch"]),
  };

  async preview(args: Json): Promise<ToolPreview> {
    const rel = this.paths.resolve(arg(args, "path"));
    const before = await this.currentText(rel);
    if (before === null) throw await this.notFound(rel);
    const after = applyUnifiedPatch(before, arg(args, "patch"), rel);
    return { kind: "file", path: rel, before, after };
  }

  async execute(args: Json, preview: ToolPreview | null): Promise<string> {
    const rel = this.paths.resolve(arg(args, "path"));
    const note = await this.applyChange(rel, preview);
    return `patched ${rel}${note ?? ""}`;
  }
}
