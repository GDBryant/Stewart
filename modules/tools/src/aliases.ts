import type { Json } from "@stewart/kernel";

export interface ToolAlias {
  target: string;
  args(a: Json): Json;
}

type Renames = Record<string, string | ((a: Json, out: Json) => void)>;

function rename(a: Json, map: Renames): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(a)) {
    const to = map[key];
    if (to === undefined) out[key] = value;
    else if (typeof to === "string") { if (!(to in a)) out[to] = value; }
    else to(a, out);
  }
  return out;
}

function renamed(map: Record<string, string>): (a: Json) => Json {
  return (a) => rename(a, map);
}

function readArgs(a: Json): Json {
  const offset = typeof a.offset === "number" && Number.isInteger(a.offset) ? a.offset : 1;
  return rename(a, {
    file_path: "path",
    offset: "start_line",
    limit: (src, out) => {
      if (typeof src.limit === "number" && Number.isInteger(src.limit)) out.end_line = offset + src.limit - 1;
    },
  });
}

export const TOOL_ALIASES: Record<string, ToolAlias> = {
  Bash: { target: "RunTerminal", args: renamed({}) },
  Read: { target: "ReadFile", args: readArgs },
  Write: { target: "WriteFile", args: renamed({ file_path: "path" }) },
  Edit: { target: "EditFile", args: renamed({ file_path: "path" }) },
  Glob: { target: "FindFiles", args: renamed({ pattern: "glob" }) },
  Grep: {
    target: "Search",
    args: (a) => {
      const out = rename(a, { pattern: "query", head_limit: "max_results" });
      if (!("regex" in out)) out.regex = true;
      return out;
    },
  },
};
