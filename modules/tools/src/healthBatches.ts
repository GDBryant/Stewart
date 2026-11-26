import type { Json, ToolSpec } from "@stewart/kernel";
import { batchInventory, isSourceFile, type InventoryEntry } from "@stewart/code-health";
import { locEntry } from "./fsRead.js";
import { arg, optBool, optInt, schema, str, int, bool, ProjectTool } from "./toolBase.js";

/** Batches listed per call: keeps one result inside the per-result cap of a 32k-window model. */
const PAGE = 15;
/** A file with unknown size (too large to read) fills a batch alone. */
const UNKNOWN_LOC = 3000;

/**
 * `health_batches`: the whole inventory for a project health check, already split into delegate-sized batches
 * (≤ 8 files and ≤ 3000 lines each), so the lead never packs files by hand. Paged by `from`.
 */
export class HealthBatches extends ProjectTool {
  spec: ToolSpec = {
    name: "health_batches",
    description:
      "Code-health inventory split into batches (≤ 8 files, ≤ 3000 lines) ready to delegate to the auditor, 15 batches per call; pass `from` to page. Use instead of ListCodeFiles plus manual packing for a project or folder health check.",
    parameters: schema({ path: str, include_tests: bool, from: int }, []),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<string> {
    const dir = args["path"] !== undefined ? await this.paths.resolveRead(arg(args, "path")) : ".";
    if (!(await this.paths.exists(dir))) throw new Error(`file not found: ${dir}`);
    const includeTests = optBool(args, "include_tests");
    const files: InventoryEntry[] = [];
    for (const rel of await this.paths.list(dir)) {
      if (!isSourceFile(rel, { includeTests })) continue;
      const e = await locEntry(this.paths, rel);
      files.push({ path: e.path, loc: e.loc ?? UNKNOWN_LOC });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return render(files, Math.max(optInt(args, "from") ?? 1, 1));
  }
}

function render(files: InventoryEntry[], from: number): string {
  if (!files.length) return "no source files";
  const batches = batchInventory(files);
  const page = batches.slice(from - 1, from - 1 + PAGE);
  if (!page.length) return `no batch ${from}; there are ${batches.length}`;
  const total = files.reduce((n, f) => n + f.loc, 0);
  const out = [`${files.length} files, ${total} lines, ${batches.length} batches. Delegate each batch to the auditor with report "health" and scope = its files.`];
  page.forEach((b, i) => out.push(`batch ${from + i} (${b.length} files, ${b.reduce((n, f) => n + f.loc, 0)} lines): ${b.map((f) => f.path).join(" ")}`));
  const next = from + page.length;
  out.push(next <= batches.length ? `[next: from=${next}; ${batches.length - next + 1} batches remain]` : "[end of batches]");
  return out.join("\n");
}
