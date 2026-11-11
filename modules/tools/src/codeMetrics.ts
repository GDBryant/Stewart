import type { Json, ToolSpec } from "@stewart/kernel";
import { isSourceFile, renderMetrics, scanMetrics, type FileMetrics } from "@stewart/code-health";
import { MAX_FILE_BYTES } from "./projectPaths.js";
import { arg, bool, optBool, schema, str, strArr, ProjectTool } from "./toolBase.js";

export class CodeMetrics extends ProjectTool {
  spec: ToolSpec = {
    name: "CodeMetrics",
    description:
      "Measure source files (any language, lexical scan): LOC, per-function branches/length/nesting, suppressions. Evidence for code-health scoring.",
    parameters: schema({ files: strArr, path: str, include_tests: bool }, []),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const { files, missing } = await this.collect(args);
    if (files.length === 0) throw new Error("no source files");
    const out = renderMetrics(files);
    return missing.length ? `${out}\n${missing.map((m) => `${m}\tnot found`).join("\n")}` : out;
  }

  private targets(args: Json): string[] {
    const v = args["files"];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [args["path"] !== undefined ? arg(args, "path") : "."];
  }

  private async collect(args: Json): Promise<{ files: FileMetrics[]; missing: string[] }> {
    const includeTests = optBool(args, "include_tests");
    const files = new Map<string, FileMetrics>();
    const missing: string[] = [];
    for (const raw of this.targets(args)) await this.collectTarget(raw, includeTests, files, missing);
    return { files: [...files.values()], missing };
  }

  private async collectTarget(raw: string, includeTests: boolean, files: Map<string, FileMetrics>, missing: string[]): Promise<void> {
    const rel = this.paths.resolve(raw);
    if (!(await this.paths.exists(rel))) {
      missing.push(rel);
      return;
    }
    const listed = await this.paths.list(rel).catch(() => [] as string[]);
    const srcs = listed.filter((p) => isSourceFile(p, { includeTests }));
    if (srcs.length > 0) {
      for (const p of srcs) await this.addFile(files, p);
    } else if (listed.length === 0 || isSourceFile(rel, { includeTests: true })) {
      await this.addFile(files, rel);
    }
  }

  private async addFile(files: Map<string, FileMetrics>, rel: string): Promise<void> {
    if (!files.has(rel)) files.set(rel, await this.measureOne(rel));
  }

  private async measureOne(rel: string): Promise<FileMetrics> {
    const base: FileMetrics = { path: rel, loc: 0, measured: false, functions: [], suppressions: [] };
    try {
      const st = await this.paths.stat(rel);
      if (st.size > MAX_FILE_BYTES) return base;
      const { content } = await this.paths.read(rel);
      if (content.slice(0, 8192).includes("\0")) return base;
      return scanMetrics(rel, content);
    } catch {
      return base;
    }
  }
}
