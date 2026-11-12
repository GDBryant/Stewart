import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Verdict {
  pass: boolean;
  evidence: string;
}

export interface CheckCtx {
  root: string;
  replies: string[];
  sh(command: string, opts?: ShOpts): Promise<{ code: number; out: string }>;
  read(rel: string): Promise<string | null>;
  changed(): Promise<string[]>;
}

export type CheckFn = (c: CheckCtx) => Promise<Verdict>;

export interface ShOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const IGNORED = /^(\.stewart|\.claude|node_modules)\//;

export function sh(command: string, opts: ShOpts & { cwd: string }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let out = "";
    const add = (d: Buffer) => {
      if (out.length < 100_000) out += d.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

export function parsePorcelain(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""))
    .filter((p) => !IGNORED.test(p));
}

export function checkCtx(root: string, replies: string[]): CheckCtx {
  return {
    root,
    replies,
    sh: (command, opts) => sh(command, { ...opts, cwd: opts?.cwd ?? root }),
    read: async (rel) => readFile(join(root, rel), "utf8").catch(() => null),
    changed: async () => parsePorcelain((await sh("git status --porcelain --untracked-files=all", { cwd: root })).out),
  };
}

export const ok = (evidence: string): Verdict => ({ pass: true, evidence });
export const fail = (evidence: string): Verdict => ({ pass: false, evidence });

export function allOf(...checks: CheckFn[]): CheckFn {
  return async (c) => {
    const passed: string[] = [];
    for (const check of checks) {
      const v = await check(c);
      if (!v.pass) return v;
      passed.push(v.evidence);
    }
    return ok(passed.join("; "));
  };
}

export function anyOf(...checks: CheckFn[]): CheckFn {
  return async (c) => {
    const failed: string[] = [];
    for (const check of checks) {
      const v = await check(c);
      if (v.pass) return v;
      failed.push(v.evidence);
    }
    return fail(failed.join(" | "));
  };
}

export function replyHas(turn: number, ...patterns: RegExp[]): CheckFn {
  return async (c) => {
    const text = c.replies[turn < 0 ? c.replies.length + turn : turn] ?? "";
    const missing = patterns.filter((p) => !p.test(text));
    return missing.length ? fail(`reply ${turn} lacks ${missing.join(", ")}`) : ok(`reply ${turn} has ${patterns.join(", ")}`);
  };
}

export function fileMatches(rel: string, test: (text: string) => boolean, what: string): CheckFn {
  return async (c) => {
    const text = await c.read(rel);
    if (text === null) return fail(`${rel} missing`);
    return test(text) ? ok(`${rel}: ${what}`) : fail(`${rel}: not ${what}`);
  };
}

export function cmdOk(command: string): CheckFn {
  return async (c) => {
    const r = await c.sh(command);
    return r.code === 0 ? ok(`\`${command}\` ok`) : fail(`\`${command}\` exited ${r.code}: ${r.out.slice(-600)}`);
  };
}

export function onlyChanged(...allowed: string[]): CheckFn {
  return async (c) => {
    const extra = (await c.changed()).filter((p) => !allowed.includes(p));
    return extra.length ? fail(`unexpected changes: ${extra.join(", ")}`) : ok(`changes within ${allowed.join(", ") || "nothing"}`);
  };
}

export const noChanges: CheckFn = onlyChanged();

export function unchanged(...paths: string[]): CheckFn {
  return async (c) => {
    const touched = (await c.changed()).filter((p) => paths.includes(p));
    return touched.length ? fail(`must not change: ${touched.join(", ")}`) : ok(`unchanged: ${paths.join(", ")}`);
  };
}

export function nodeEval(script: string, label: string): CheckFn {
  return async (c) => {
    const r = await c.sh('node --input-type=module -e "$EVAL_SCRIPT"', { env: { EVAL_SCRIPT: script } });
    return r.code === 0 ? ok(label) : fail(`${label} failed: ${r.out.slice(-600)}`);
  };
}
