import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../kit.js";
import { runTurn, startCore, type RunOpts, type TurnResult } from "../runner.js";
import { prepareConfig, type Workspace } from "../workspace.js";
import { extractRepo, nodeExec, pullImage, removeImage, runEval, writeEvalDir, type Exec } from "./docker.js";
import { grade, type Grade } from "./grade.js";
import type { Instance } from "./instances.js";

export interface SweOpts extends RunOpts {
  patchSource: "lead" | "gold" | "none";
  timeoutMin: number;
  testTimeoutMin: number;
  rmi: boolean;
  logDir: string;
}

export interface SweDeps {
  exec?: Exec;
  startCore?: typeof startCore;
}

export interface SweResult extends Grade {
  id: string;
  repo: string;
  patch: string;
  turn?: TurnResult;
  log?: string;
  workspace?: string;
  durationMs: number;
  costUsd: number;
}

const GIT = "git -c user.name=eval -c user.email=eval@example.com -c commit.gpgsign=false";
const GIT_TIMEOUT_MS = 10 * 60_000;
const EMPTY = { passed: 0, total: 0 };

export function prompt(inst: Instance): string {
  return [
    "Resolve the issue below in this repository by editing its source files.",
    "Do not add or change tests. The project's Python test environment is not installed on this machine, so do not try to run its test suite; your change is tested separately afterwards.",
    "",
    inst.problem_statement,
  ].join("\n");
}

async function git(repo: string, args: string): Promise<string> {
  const r = await sh(`${GIT} ${args}`, { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 60)} failed (${r.code}): ${r.out.trim().slice(-300)}`);
  return r.out.trim();
}

export async function baseline(repo: string): Promise<string> {
  await git(repo, "add -A");
  await git(repo, 'commit -q --allow-empty -m "eval baseline"');
  return git(repo, "rev-parse HEAD");
}

export async function diffSince(repo: string, base: string, outFile: string): Promise<string> {
  await git(repo, "add -A -- . ':(exclude).stewart' ':(exclude).claude'");
  await git(repo, `diff --cached --binary ${base} -- . ':(exclude).stewart' ':(exclude).claude' > '${outFile}'`);
  return readFile(outFile, "utf8");
}

interface LeadRun {
  patch: string;
  turn: TurnResult;
  ws: Workspace;
}

async function leadRun(inst: Instance, opts: SweOpts, deps: SweDeps): Promise<LeadRun> {
  const dir = await mkdtemp(join(tmpdir(), `stewart-swe-${inst.instance_id}-`));
  const ws: Workspace = { dir, repo: join(dir, "repo"), state: join(dir, "state"), config: join(dir, "config") };
  try {
    await mkdir(ws.state, { recursive: true });
    await extractRepo(deps.exec ?? nodeExec, inst.image, ws.repo);
    const base = await baseline(ws.repo);
    await prepareConfig(opts.config, ws.config, false);
    const { log, dispatch } = await (deps.startCore ?? startCore)(ws, opts);
    const turn = await runTurn({ log, dispatch, sessionId: `swe-${inst.instance_id}`, timeoutMs: opts.timeoutMin * 60_000 }, prompt(inst));
    const patch = await diffSince(ws.repo, base, join(dir, "model.patch"));
    return { patch, turn, ws };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function score(inst: Instance, src: PatchSrc, opts: SweOpts, exec: Exec): Promise<{ g: Grade; log?: string }> {
  const { patch } = src;
  const runError = src.error ? ` (run ${src.error})` : "";
  if (!patch.trim() && opts.patchSource === "lead") return { g: { status: "unresolved", reason: `empty patch: the run changed no file${runError}`, f2p: EMPTY, p2p: EMPTY, failed: [] } };
  const dir = await mkdtemp(join(tmpdir(), "stewart-swe-eval-"));
  try {
    await writeEvalDir(dir, patch, inst.eval_script);
    const name = `stewart-swe-${inst.instance_id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}-${Date.now().toString(36)}`;
    const content = await runEval(exec, { image: inst.image, dir, name, timeoutMs: opts.testTimeoutMin * 60_000 });
    await mkdir(opts.logDir, { recursive: true });
    const log = join(opts.logDir, `${inst.instance_id}.log`);
    await writeFile(log, content);
    return { g: grade(content, inst), log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface PatchSrc {
  patch: string;
  error?: string;
}

function patchOf(inst: Instance, opts: SweOpts, lead: LeadRun | undefined): PatchSrc {
  if (lead) return { patch: lead.patch, error: lead.turn.error };
  return { patch: opts.patchSource === "gold" ? inst.patch : "" };
}

function errorGrade(e: unknown): Grade {
  return { status: "error", reason: e instanceof Error ? e.message : String(e), f2p: EMPTY, p2p: EMPTY, failed: [] };
}

async function attempt(inst: Instance, opts: SweOpts, deps: SweDeps): Promise<{ g: Grade; log?: string; lead?: LeadRun }> {
  const exec = deps.exec ?? nodeExec;
  let lead: LeadRun | undefined;
  try {
    await pullImage(exec, inst.image);
    if (opts.patchSource === "lead") lead = await leadRun(inst, opts, deps);
    return { ...(await score(inst, patchOf(inst, opts, lead), opts, exec)), lead };
  } catch (e) {
    return { g: errorGrade(e), lead };
  }
}

export async function runInstance(inst: Instance, opts: SweOpts, deps: SweDeps = {}): Promise<SweResult> {
  const started = Date.now();
  const { g, log, lead } = await attempt(inst, opts, deps);
  const keep = lead !== undefined && (opts.keep === "always" || (opts.keep === "failed" && g.status !== "resolved"));
  if (lead && !keep) await rm(lead.ws.dir, { recursive: true, force: true });
  if (opts.rmi) await removeImage(deps.exec ?? nodeExec, inst.image);
  return {
    ...g,
    id: inst.instance_id,
    repo: inst.repo,
    patch: patchOf(inst, opts, lead).patch,
    turn: lead?.turn,
    log,
    workspace: keep ? lead?.ws.dir : undefined,
    durationMs: Date.now() - started,
    costUsd: lead?.turn.costUsd ?? 0,
  };
}
