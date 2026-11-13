import type { HostPort } from "@stewart/kernel";

const CONTEXT_LIMIT = 4000;

/** Bounded `AGENTS.md` + `MEMORY.md` blocks appended to role prompts, in deterministic prefix order. */
export async function loadProjectContext(host: Pick<HostPort, "files" | "workspace">): Promise<string> {
  let out = "";
  const roots = await host.workspace.roots().catch(() => [] as string[]);
  out += roots.length
    ? `\n\n# Workspace\nProject root: ${roots[0]}\nUse workspace-relative paths with project tools; RunTerminal, GetDiff and the Claude CLI all run in the project root.`
    : `\n\n# Workspace\nProject root unavailable from host; use workspace-relative paths and do not guess an absolute root.`;
  try {
    if (await host.files.exists("AGENTS.md")) {
      const md = (await host.files.read("AGENTS.md")).content;
      out += `\n\n# Project instructions (AGENTS.md)\n${md.slice(0, CONTEXT_LIMIT)}`;
    }
  } catch {
    /* no AGENTS.md is fine */
  }
  try {
    if (await host.files.exists("MEMORY.md")) {
      const mem = (await host.files.read("MEMORY.md")).content;
      out += `\n\n# Project memory (MEMORY.md)\n${mem.slice(0, CONTEXT_LIMIT)}`;
    }
  } catch {
    /* no MEMORY.md is fine */
  }
  return out;
}
