import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sh } from "../kit.js";
import { loadDotEnv } from "../main.js";
import { formatQualification, qualifyConfig } from "../qualify.js";
import { PACKAGE_DIR } from "../workspace.js";
import { loadInstances, selectInstances, type Instance } from "./instances.js";
import { formatRow, formatTable, writeResults } from "./report.js";
import { runInstance, type SweOpts, type SweResult } from "./run.js";

const USAGE =
  "usage: node dist/swebench/main.js --dataset <SWE-bench_Verified.jsonl> --label <name> [--gold|--no-patch] [--config <dir>] [--only id,id|all] [--parallel n] [--timeout-min n] [--test-timeout-min n] [--keep never|failed|always] [--rmi] [--skip-qualify]";

const OPTIONS = {
  dataset: { type: "string" },
  label: { type: "string" },
  gold: { type: "boolean", default: false },
  "no-patch": { type: "boolean", default: false },
  config: { type: "string", default: join(homedir(), ".config", "stewart") },
  only: { type: "string" },
  parallel: { type: "string", default: "1" },
  "timeout-min": { type: "string", default: "30" },
  "test-timeout-min": { type: "string", default: "30" },
  keep: { type: "string", default: "never" },
  rmi: { type: "boolean", default: false },
  "skip-qualify": { type: "boolean", default: false },
} as const;

export interface MainDeps {
  run?: typeof runInstance;
  qualify?: typeof qualifyConfig;
  resultsDir?: string;
}

export async function pool(instances: Instance[], parallel: number, run: (i: Instance) => Promise<SweResult>): Promise<SweResult[]> {
  const out: SweResult[] = new Array(instances.length);
  let next = 0;
  const worker = async () => {
    while (next < instances.length) {
      const i = next++;
      out[i] = await run(instances[i]);
      console.log(formatRow(out[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return out;
}

function positive(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${flag} must be a positive number`);
  return n;
}

function parse(argv: string[]): { opts: SweOpts; dataset: string; label: string; only?: string; parallel: number; skipQualify: boolean } {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  if (!values.dataset || !values.label) throw new Error(USAGE);
  if (!["never", "failed", "always"].includes(values.keep) || (values.gold && values["no-patch"])) throw new Error(USAGE);
  const opts: SweOpts = {
    config: resolve(values.config),
    disableLead: false,
    keep: values.keep as SweOpts["keep"],
    patchSource: values.gold ? "gold" : values["no-patch"] ? "none" : "lead",
    timeoutMin: positive(values["timeout-min"], "timeout-min"),
    testTimeoutMin: positive(values["test-timeout-min"], "test-timeout-min"),
    rmi: values.rmi,
    logDir: join(PACKAGE_DIR, "results", "swebench-logs", values.label),
  };
  return { opts, dataset: resolve(values.dataset), label: values.label, only: values.only, parallel: positive(values.parallel, "parallel"), skipQualify: values["skip-qualify"] || opts.patchSource !== "lead" };
}

export async function main(argv: string[] = process.argv.slice(2), deps: MainDeps = {}): Promise<void> {
  const a = parse(argv);
  loadDotEnv(join(PACKAGE_DIR, ".env"));
  const startedAt = new Date().toISOString();
  const selected = selectInstances(await loadInstances(a.dataset), a.only);
  const q = a.skipQualify ? undefined : await (deps.qualify ?? qualifyConfig)(a.opts.config, a.opts);
  if (q) console.log(formatQualification(q.rows));
  const run = deps.run ?? runInstance;
  let results: SweResult[];
  try {
    results = await pool(selected, a.parallel, (i) => run(i, { ...a.opts, config: q?.config ?? a.opts.config }));
  } finally {
    await q?.cleanup();
  }
  const commit = (await sh("git rev-parse --short HEAD", { cwd: PACKAGE_DIR })).out.trim();
  const meta = { label: a.label, startedAt, commit, config: a.opts.config, dataset: a.dataset, patchSource: a.opts.patchSource, qualification: q?.rows };
  const file = await writeResults(deps.resultsDir ?? join(PACKAGE_DIR, "results"), meta, results);
  console.log(`\n${formatTable(a.label, results)}\nresults: ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(PACKAGE_DIR, "dist", "swebench", "main.js")) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
