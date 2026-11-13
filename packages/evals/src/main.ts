import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sh } from "./kit.js";
import { formatQualification, qualifyConfig, type Qualified } from "./qualify.js";
import { formatTable, summarize, writeResults, type ResultsFile } from "./results.js";
import { runTask, type RunOpts, type TaskResult } from "./runner.js";
import { TASKS, type EvalTask } from "./tasks.js";
import { PACKAGE_DIR } from "./workspace.js";

export function loadDotEnv(file: string, env: Record<string, string | undefined> = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function selectTasks(only: string | undefined, all: EvalTask[] = TASKS): EvalTask[] {
  if (!only) return all;
  const ids = only.split(",").map((s) => s.trim());
  const unknown = ids.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(", ")}`);
  return all.filter((t) => ids.includes(t.id));
}

export async function pool(tasks: EvalTask[], parallel: number, opts: RunOpts, run: typeof runTask = runTask): Promise<TaskResult[]> {
  const out: TaskResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await run(tasks[i], opts);
      console.log(`${out[i].pass ? "PASS" : "FAIL"} ${tasks[i].id}: ${out[i].evidence.slice(0, 200)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return out;
}

const USAGE = "usage: node dist/main.js --label <name> [--config <dir>] [--disable-lead] [--only id,id] [--parallel n] [--keep never|failed|always] [--skip-qualify]";

/** Qualify the config's agents for real unless skipped; tasks then run on the qualified copy. */
async function qualified(opts: RunOpts, skip: boolean, qualify: typeof qualifyConfig): Promise<Qualified | undefined> {
  if (skip) return undefined;
  const q = await qualify(opts.config, opts);
  console.log(formatQualification(q.rows));
  return q;
}

export async function main(argv: string[] = process.argv.slice(2), run: typeof runTask = runTask, qualify: typeof qualifyConfig = qualifyConfig): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      config: { type: "string", default: join(homedir(), ".config", "stewart") },
      "disable-lead": { type: "boolean", default: false },
      only: { type: "string" },
      parallel: { type: "string", default: "1" },
      keep: { type: "string", default: "failed" },
      "skip-qualify": { type: "boolean", default: false },
    },
  });
  if (!values.label) throw new Error(USAGE);
  loadDotEnv(join(PACKAGE_DIR, ".env"));
  const startedAt = new Date().toISOString();
  const opts: RunOpts = { config: resolve(values.config!), disableLead: values["disable-lead"]!, keep: values.keep as RunOpts["keep"] };
  const selected = selectTasks(values.only);
  const q = await qualified(opts, values["skip-qualify"]!, qualify);
  let tasks: TaskResult[];
  try {
    tasks = await pool(selected, Number(values.parallel), { ...opts, config: q?.config ?? opts.config }, run);
  } finally {
    await q?.cleanup();
  }
  const commit = (await sh("git rev-parse --short HEAD", { cwd: PACKAGE_DIR })).out.trim();
  const results: ResultsFile = { label: values.label, startedAt, commit, config: opts.config, qualification: q?.rows, summary: summarize(tasks), tasks };
  const file = await writeResults(join(PACKAGE_DIR, "results"), results);
  console.log(`\n${formatTable(results)}\nresults: ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(PACKAGE_DIR, "dist", "main.js")) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
