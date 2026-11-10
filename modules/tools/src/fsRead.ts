import type { Json, ToolSpec } from "@stewart/kernel";
import { isSourceFile } from "@stewart/code-health";
import { MAX_FILE_BYTES, MAX_FIND_RESULTS, MAX_SEARCH_RESULTS, type ProjectPaths } from "./projectPaths.js";
import { arg, optBool, optInt, schema, str, int, bool, ProjectTool } from "./toolBase.js";

function isBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\0");
}

function globStar(glob: string, i: number): { re: string; next: number } {
  if (glob[i + 1] === "*") {
    if (glob[i + 2] === "/") return { re: "(?:[^/]+/)*", next: i + 3 };
    return { re: ".*", next: i + 2 };
  }
  return { re: "[^/]*", next: i + 1 };
}

function globClass(glob: string, i: number): { re: string; next: number } {
  const j = glob.indexOf("]", i + 1);
  if (j === -1) throw new Error("invalid glob: unterminated [");
  return { re: glob.slice(i, j + 1), next: j + 1 };
}

function globBrace(glob: string, i: number): { re: string; next: number } {
  const j = glob.indexOf("}", i + 1);
  if (j === -1) throw new Error("invalid glob: unterminated {");
  const alts = glob.slice(i + 1, j).split(",").map((a) => a.replace(/[.+^$()|\\]/g, "\\$&"));
  return { re: `(?:${alts.join("|")})`, next: j + 1 };
}

function globLiteral(glob: string, i: number): { re: string; next: number } {
  return { re: glob[i].replace(/[.+^$()|\\]/g, "\\$&"), next: i + 1 };
}

const GLOB_ATOMS: Record<string, (glob: string, i: number) => { re: string; next: number }> = {
  "*": globStar,
  "?": (_glob, i) => ({ re: "[^/]", next: i + 1 }),
  "[": globClass,
  "{": globBrace,
};

function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const h = GLOB_ATOMS[glob[i]] ?? ((_g: string, j: number) => globLiteral(_g, j));
    const r = h(glob, i);
    re += r.re;
    i = r.next;
  }
  return new RegExp(`^${re}$`);
}

export class ReadFile extends ProjectTool {
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

function findMatcher(glob: string): RegExp {
  try {
    return globToRegex(glob);
  } catch (e) {
    throw new Error(`invalid glob: ${e instanceof Error ? e.message : e}`);
  }
}

export class FindFiles extends ProjectTool {
  spec: ToolSpec = {
    name: "FindFiles",
    description: "Find/list project files matching a glob — any file type; '**/*' lists everything under path",
    parameters: schema({ glob: str, path: str }, ["glob"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const matcher = findMatcher(arg(args, "glob"));
    const dir = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : ".";
    if (!(await this.paths.exists(dir))) throw new Error(`file not found: ${dir}`);
    const base = dir === "." ? "" : `${dir.replace(/\/+$/, "")}/`;
    const results: string[] = [];
    let overflow = 0;
    for (const p of await this.paths.list(dir)) {
      if (findMatch(p, base, matcher, results)) overflow++;
    }
    if (overflow > 0) results.push(`[${overflow} more]`);
    return results.length === 0 ? "no files matched" : results.join("\n");
  }
}

function findMatch(p: string, base: string, matcher: RegExp, results: string[]): boolean {
  const rel = base && p.startsWith(base) ? p.slice(base.length) : p;
  if (!(matcher.test(p) || matcher.test(rel))) return false;
  if (results.length < MAX_FIND_RESULTS) {
    results.push(p);
    return false;
  }
  return true;
}

async function locEntry(paths: ProjectPaths, rel: string): Promise<{ path: string; loc: number | null }> {
  try {
    const st = await paths.stat(rel);
    if (st.size > MAX_FILE_BYTES) return { path: rel, loc: null };
    const { content } = await paths.read(rel);
    return { path: rel, loc: content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0) };
  } catch {
    return { path: rel, loc: null };
  }
}

export class ListCodeFiles extends ProjectTool {
  spec: ToolSpec = {
    name: "ListCodeFiles",
    description: "Inventory source-code files only (.ts/.js/.py/...) with line counts, LOC-desc; not a directory listing — use FindFiles for docs/assets/any files",
    parameters: schema({ path: str, include_tests: bool }, []),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const dir = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : ".";
    if (!(await this.paths.exists(dir))) throw new Error(`file not found: ${dir}`);
    const includeTests = optBool(args, "include_tests");
    const entries: { path: string; loc: number | null }[] = [];
    for (const rel of await this.paths.list(dir)) {
      if (!isSourceFile(rel, { includeTests })) continue;
      entries.push(await locEntry(this.paths, rel));
    }
    entries.sort((a, b) => (b.loc ?? -1) - (a.loc ?? -1));
    const shown = entries.slice(0, MAX_FIND_RESULTS).map((e) => `${e.path}\t${e.loc ?? "?"}`);
    if (entries.length > MAX_FIND_RESULTS) shown.push(`[${entries.length - MAX_FIND_RESULTS} more]`);
    return shown.length === 0 ? "no source files" : shown.join("\n");
  }
}

function queryRegex(query: string, useRegex: boolean): RegExp | null {
  if (!useRegex) return null;
  try {
    return new RegExp(query);
  } catch (e) {
    throw new Error(`invalid regex: ${e instanceof Error ? e.message : e}`);
  }
}

function scanContent(rel: string, content: string, query: string, regex: RegExp | null, max: number, results: string[]): number {
  let overflow = 0;
  content.split("\n").forEach((line, i) => {
    const hit = regex ? regex.test(line) : line.includes(query);
    if (hit) {
      if (results.length < max) results.push(`${rel}:${i + 1}: ${line}`);
      else overflow++;
    }
  });
  return overflow;
}

export class Search extends ProjectTool {
  spec: ToolSpec = {
    name: "Search",
    description: "Search file contents in the project",
    parameters: schema({ query: str, regex: bool, path: str, max_results: int }, ["query"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const query = arg(args, "query");
    const regex = queryRegex(query, optBool(args, "regex"));
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
        overflow += scanContent(rel, content, query, regex, max, results);
      } catch {
      }
    }
    if (overflow > 0) results.push(`[${overflow} more]`);
    return results.length === 0 ? "no matches" : results.join("\n");
  }
}

export class GetProblems extends ProjectTool {
  spec: ToolSpec = {
    name: "GetProblems",
    description: "List IDE diagnostics for the workspace or a file",
    parameters: schema({ path: str }, []),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const rel = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : undefined;
    const problems = await this.host.diag.problems(rel);
    if (problems.length === 0) return "no problems";
    return problems.map((p) => `${p.path}:${p.line} [${p.severity}]: ${p.message}`).join("\n");
  }
}
