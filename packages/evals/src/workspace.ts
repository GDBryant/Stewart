import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { sh } from "./kit.js";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(PACKAGE_DIR, "fixture");
const GIT = "git -c user.name=eval -c user.email=eval@example.com -c commit.gpgsign=false";

export interface Workspace {
  dir: string;
  repo: string;
  state: string;
  config: string;
}

async function git(repo: string, args: string): Promise<void> {
  const r = await sh(`${GIT} ${args}`, { cwd: repo });
  if (r.code !== 0) throw new Error(`git ${args}: ${r.out}`);
}

/** Fresh repo: fixture/base committed, then fixture/last-commit committed on top. */
export async function prepareRepo(repo: string, fixture = FIXTURE): Promise<void> {
  await cp(join(fixture, "base"), repo, { recursive: true });
  await git(repo, "init -q -b main");
  await git(repo, "add -A");
  await git(repo, 'commit -q -m "Initial commit"');
  await cp(join(fixture, "last-commit"), repo, { recursive: true, force: true });
  await git(repo, "add -A");
  await git(repo, 'commit -q -m "Add truncate helper"');
}

/** Copies the config dir; `disableLead` pins the `lead` role off (baseline = old orchestrated path). */
export async function prepareConfig(src: string, dest: string, disableLead: boolean): Promise<void> {
  await mkdir(dest, { recursive: true });
  if (existsSync(src)) await cp(src, dest, { recursive: true });
  if (!disableLead) return;
  const file = join(dest, "roles.yaml");
  const doc = (existsSync(file) ? parse(await readFile(file, "utf8")) : null) ?? { version: 1, items: [] };
  const items = (doc.items ?? []) as { id: string; enabled?: boolean }[];
  const lead = items.find((r) => r.id === "lead");
  if (lead) lead.enabled = false;
  else items.push({ id: "lead", enabled: false });
  await writeFile(file, stringify({ ...doc, items }));
}

export async function createWorkspace(taskId: string, configSrc: string, disableLead: boolean): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `stewart-eval-${taskId}-`));
  const ws = { dir, repo: join(dir, "repo"), state: join(dir, "state"), config: join(dir, "config") };
  await mkdir(ws.state, { recursive: true });
  await prepareRepo(ws.repo);
  await prepareConfig(configSrc, ws.config, disableLead);
  return ws;
}

export async function removeWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.dir, { recursive: true, force: true });
}
