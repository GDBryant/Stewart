import type { HostPort } from "../ports.js";
import {
  MAX_COMMAND_OUTPUT, MAX_FILE_BYTES, MAX_FIND_RESULTS, MAX_SEARCH_RESULTS, ProjectPaths,
} from "./projectPaths.js";
import { ToolRegistry, type Json, type Tool, type ToolPreview, type ToolSpec } from "./types.js";

function arg(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing '${key}'`);
  return v;
}

function optInt(args: Json, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function optBool(args: Json, key: string): boolean {
  return args[key] === true;
}

function schema(props: Record<string, Json>, required: string[]): Json {
  return { type: "object", properties: props, required, additionalProperties: false };
}

const str: Json = { type: "string" };
const int: Json = { type: "integer" };
const bool: Json = { type: "boolean" };

function isBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\0");
}

function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j === -1) throw new Error("invalid glob: unterminated [");
      re += glob.slice(i, j + 1);
      i = j + 1;
    } else if (c === "{") {
      const j = glob.indexOf("}", i + 1);
      if (j === -1) throw new Error("invalid glob: unterminated {");
      const alts = glob.slice(i + 1, j).split(",").map((a) => a.replace(/[.+^$()|\\]/g, "\\$&"));
      re += `(?:${alts.join("|")})`;
      i = j + 1;
    } else {
      re += c.replace(/[.+^$()|\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

abstract class ProjectTool implements Tool {
  constructor(protected host: HostPort, protected paths: ProjectPaths) {}
  abstract spec: ToolSpec;
  abstract requiresApproval: boolean;
  readonly awaitsUser = false;
  abstract execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string>;
}

class ReadFile extends ProjectTool {
  spec: ToolSpec = {
    name: "ReadFile",
    description: "Read a project file",
    parameters: schema({ path: str, start_line: int, end_line: int }, ["path"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const rel = this.paths.resolve(arg(args, "path"));
    if (!(await this.paths.exists(rel))) throw new Error(`file not found: ${rel}`);
    const st = await this.paths.stat(rel);
    if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
    const { content } = await this.paths.read(rel);
    if (isBinary(content)) throw new Error(`binary file: ${rel}`);
    const lines = content.split("\n");
    const start = optInt(args, "start_line") ?? 1;
    const end = optInt(args, "end_line") ?? lines.length;
    if (start < 1 || end < start || start > lines.length) {
      throw new Error(`invalid line range ${start}-${end} (file has ${lines.length} lines)`);
    }
    return lines.slice(start - 1, Math.min(end, lines.length)).map((l, i) => `${start + i}: ${l}`).join("\n");
  }
}

class FindFiles extends ProjectTool {
  spec: ToolSpec = {
    name: "FindFiles",
    description: "Find project files matching a glob",
    parameters: schema({ glob: str, path: str }, ["glob"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    let matcher: RegExp;
    try {
      matcher = globToRegex(arg(args, "glob"));
    } catch (e) {
      throw new Error(`invalid glob: ${e instanceof Error ? e.message : e}`);
    }
    const dir = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : ".";
    if (!(await this.paths.exists(dir))) throw new Error(`file not found: ${dir}`);
    const results: string[] = [];
    let overflow = 0;
    for (const p of await this.paths.list(dir)) {
      if (matcher.test(p)) {
        if (results.length < MAX_FIND_RESULTS) results.push(p);
        else overflow++;
      }
    }
    if (overflow > 0) results.push(`[${overflow} more]`);
    return results.length === 0 ? "no files matched" : results.join("\n");
  }
}

class Search extends ProjectTool {
  spec: ToolSpec = {
    name: "Search",
    description: "Search file contents in the project",
    parameters: schema({ query: str, regex: bool, path: str, max_results: int }, ["query"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const query = arg(args, "query");
    let regex: RegExp | null = null;
    if (optBool(args, "regex")) {
      try {
        regex = new RegExp(query);
      } catch (e) {
        throw new Error(`invalid regex: ${e instanceof Error ? e.message : e}`);
      }
    }
    const dir = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : ".";
    if (!(await this.paths.exists(dir))) throw new Error(`file not found: ${dir}`);
    const max = Math.min(Math.max(optInt(args, "max_results") ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    const results: string[] = [];
    let overflow = 0;
    for (const rel of await this.paths.list(dir)) {
      if (results.length >= max) {
        overflow++;
        continue;
      }
      try {
        const st = await this.paths.stat(rel);
        if (st.size > MAX_FILE_BYTES) continue;
        const { content } = await this.paths.read(rel);
        if (isBinary(content)) continue;
        content.split("\n").forEach((line, i) => {
          const hit = regex ? regex.test(line) : line.includes(query);
          if (hit) {
            if (results.length < max) results.push(`${rel}:${i + 1}: ${line}`);
            else overflow++;
          }
        });
      } catch {
        continue;
      }
    }
    if (overflow > 0) results.push(`[${overflow} more]`);
    return results.length === 0 ? "no matches" : results.join("\n");
  }
}

abstract class EditTool extends ProjectTool {
  requiresApproval = true;

  protected async currentText(rel: string): Promise<string | null> {
    if (!(await this.paths.exists(rel))) return null;
    const { content } = await this.paths.read(rel);
    return content;
  }

  protected async applyChange(rel: string, preview: ToolPreview | null): Promise<void> {
    const change = preview?.kind === "file" ? preview : null;
    if (!change) throw new Error("missing preview");
    const current = await this.currentText(rel);
    if ((current ?? null) !== change.before) {
      throw new Error(`file changed since preview: ${rel}`);
    }
    await this.host.files.edit({ path: rel, content: change.after });
    const disk = await this.host.files.readBack(rel).catch(() => null);
    if (disk === null) throw new Error(`file missing after write: ${rel}; side effects uncertain`);
    if (disk.replace(/\r\n/g, "\n") !== change.after.replace(/\r\n/g, "\n")) {
      throw new Error(`file content differs from approved change; side effects uncertain: ${rel}`);
    }
  }
}

class WriteFile extends EditTool {
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
    await this.applyChange(rel, preview);
    const lines = arg(args, "content").split("\n").length;
    return `wrote ${rel} (${lines} lines)`;
  }
}

class EditFile extends EditTool {
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
    if (before === null) throw new Error(`file not found: ${rel}`);
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
    await this.applyChange(rel, preview);
    return `edited ${rel}`;
  }
}

class RunTerminal extends ProjectTool {
  spec: ToolSpec = {
    name: "RunTerminal",
    description: "Run a shell command",
    parameters: schema({ command: str, cwd: str }, ["command"]),
  };
  requiresApproval = true;

  private cwd(args: Json): string {
    return args["cwd"] !== undefined ? this.paths.resolve(arg(args, "cwd")) : ".";
  }

  async preview(args: Json): Promise<ToolPreview> {
    return { kind: "command", command: arg(args, "command"), cwd: this.cwd(args) };
  }

  async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string> {
    const approved = preview?.kind === "command" ? preview : null;
    if (!approved) throw new Error("missing preview");
    const command = arg(args, "command");
    const cwd = this.cwd(args);
    if (approved.command !== command || approved.cwd !== cwd) {
      throw new Error("command changed since approval");
    }
    const argv = process.platform === "win32" ? ["cmd", "/c", command] : ["/bin/sh", "-c", command];
    let output = "";
    const proc = this.host.proc.run(argv, {
      cwd: this.paths.absolute(cwd === "." ? "" : cwd),
      onData: (d) => {
        if (output.length < MAX_COMMAND_OUTPUT) output += d.slice(0, MAX_COMMAND_OUTPUT - output.length);
      },
    });
    const onAbort = () => void proc.killTree();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { code } = await proc.done;
      return `exit code: ${code}\n${output}`;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function projectTools(host: HostPort, paths: ProjectPaths): ToolRegistry {
  return new ToolRegistry([
    new ReadFile(host, paths),
    new FindFiles(host, paths),
    new Search(host, paths),
    new WriteFile(host, paths),
    new EditFile(host, paths),
    new RunTerminal(host, paths),
  ]);
}
