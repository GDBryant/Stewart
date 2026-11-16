import { readFile } from "node:fs/promises";

export interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  image: string;
  eval_script: string;
  log_parser: string;
}

const STRINGS = ["instance_id", "repo", "base_commit", "problem_statement", "patch", "image", "eval_script", "log_parser"] as const;
const LISTS = ["FAIL_TO_PASS", "PASS_TO_PASS"] as const;
const HINT = "use the SWE-bench/SWE-bench_Verified export (it carries image, eval_script and log_parser per instance)";

function idList(v: unknown, field: string, where: string): string[] {
  const list: unknown = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new Error(`${where}: ${field} is not a list of test ids`);
  return list as string[];
}

export function parseInstance(row: Record<string, unknown>, where: string): Instance {
  for (const k of STRINGS) {
    if (typeof row[k] !== "string" || row[k] === "") throw new Error(`${where}: missing ${k}; ${HINT}`);
  }
  const out = Object.fromEntries(STRINGS.map((k) => [k, row[k]])) as unknown as Instance;
  for (const k of LISTS) out[k] = idList(row[k], k, where);
  return out;
}
export async function loadInstances(file: string): Promise<Instance[]> {
  const lines = (await readFile(file, "utf8")).split("\n");
  const out: Instance[] = [];
  lines.forEach((line, i) => {
    if (line.trim()) out.push(parseInstance(JSON.parse(line) as Record<string, unknown>, `${file}:${i + 1}`));
  });
  return out;
}
export const SUBSET_20: readonly string[] = [
  "django__django-11119",
  "django__django-11740",
  "django__django-12663",
  "django__django-13346",
  "django__django-13933",
  "django__django-14580",
  "django__django-15280",
  "django__django-15973",
  "django__django-16661",
  "sympy__sympy-13757",
  "sympy__sympy-17655",
  "sympy__sympy-22714",
  "sphinx-doc__sphinx-8120",
  "sphinx-doc__sphinx-9673",
  "matplotlib__matplotlib-24570",
  "scikit-learn__scikit-learn-14053",
  "astropy__astropy-13579",
  "pydata__xarray-4695",
  "pytest-dev__pytest-7324",
  "pylint-dev__pylint-6528",
];

export function selectInstances(all: Instance[], only: string | undefined, subset: readonly string[] = SUBSET_20): Instance[] {
  const ids = only === "all" ? all.map((i) => i.instance_id) : only ? only.split(",").map((s) => s.trim()) : [...subset];
  const byId = new Map(all.map((i) => [i.instance_id, i]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`instance ids not in the dataset: ${unknown.join(", ")}`);
  return ids.map((id) => byId.get(id)!);
}
