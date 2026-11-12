import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskResult } from "./runner.js";

export interface Summary {
  passed: number;
  total: number;
  rate: number;
  statusAgrees: number;
  escalated: number;
  byKind: Record<string, { passed: number; total: number }>;
  costUsd: number;
}

export interface ResultsFile {
  label: string;
  startedAt: string;
  commit: string;
  config: string;
  summary: Summary;
  tasks: TaskResult[];
}

export function summarize(tasks: TaskResult[]): Summary {
  const byKind: Summary["byKind"] = {};
  for (const t of tasks) {
    const k = (byKind[t.kind] ??= { passed: 0, total: 0 });
    k.total++;
    if (t.pass) k.passed++;
  }
  const passed = tasks.filter((t) => t.pass).length;
  return {
    passed,
    total: tasks.length,
    rate: tasks.length ? Math.round((passed / tasks.length) * 1000) / 10 : 0,
    statusAgrees: tasks.filter((t) => t.statusAgrees).length,
    escalated: tasks.filter((t) => t.turns.some((x) => x.escalations?.length)).length,
    byKind,
    costUsd: Math.round(tasks.reduce((s, t) => s + t.costUsd, 0) * 10_000) / 10_000,
  };
}

export function formatTable(r: ResultsFile): string {
  const rows = r.tasks.map((t) => {
    const statuses = t.turns.map((x) => x.status).join(",");
    return `${t.pass ? "PASS" : "FAIL"}  ${t.id.padEnd(22)} ${statuses.padEnd(16)} ${(t.durationMs / 1000).toFixed(0).padStart(5)}s  ${t.evidence.slice(0, 160)}`;
  });
  const s = r.summary;
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${k} ${v.passed}/${v.total}`).join(", ");
  return [...rows, `${r.label}: ${s.passed}/${s.total} (${s.rate}%) — ${kinds}; status agrees ${s.statusAgrees}/${s.total}; escalated ${s.escalated}; cost $${s.costUsd}`].join("\n");
}

export async function writeResults(dir: string, r: ResultsFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${r.startedAt.slice(0, 10)}-${r.label}.json`);
  await writeFile(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}
