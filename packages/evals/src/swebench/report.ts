import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QualRow } from "../qualify.js";
import type { SweResult } from "./run.js";

export interface SweSummary {
  resolved: number;
  unresolved: number;
  errors: number;
  total: number;
  rate: number;
  byRepo: Record<string, { resolved: number; total: number }>;
  costUsd: number;
}

export interface SweResultsFile {
  label: string;
  startedAt: string;
  commit: string;
  config: string;
  dataset: string;
  patchSource: "lead" | "gold" | "none";
  qualification?: QualRow[];
  summary: SweSummary;
  instances: Omit<SweResult, "patch">[];
}

export function summarize(results: SweResult[]): SweSummary {
  const byRepo: SweSummary["byRepo"] = {};
  for (const r of results) {
    const k = (byRepo[r.repo] ??= { resolved: 0, total: 0 });
    k.total++;
    if (r.status === "resolved") k.resolved++;
  }
  const count = (s: SweResult["status"]) => results.filter((r) => r.status === s).length;
  const resolved = count("resolved");
  return {
    resolved,
    unresolved: count("unresolved"),
    errors: count("error"),
    total: results.length,
    rate: results.length ? Math.round((resolved / results.length) * 1000) / 10 : 0,
    byRepo,
    costUsd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 10_000) / 10_000,
  };
}

const tally = (t: { passed: number; total: number }): string => `${t.passed}/${t.total}`;

export function formatRow(r: SweResult): string {
  const run = r.turn ? r.turn.status : "-";
  return `${r.status.toUpperCase().padEnd(10)} ${r.id.padEnd(34)} f2p ${tally(r.f2p).padEnd(7)} p2p ${tally(r.p2p).padEnd(9)} run ${run.padEnd(8)} ${(r.durationMs / 1000).toFixed(0).padStart(5)}s  ${r.reason.slice(0, 140)}`;
}

export function formatTable(label: string, results: SweResult[]): string {
  const s = summarize(results);
  const repos = Object.entries(s.byRepo).map(([k, v]) => `${k} ${v.resolved}/${v.total}`).join(", ");
  const total = `${label}: resolved ${s.resolved}/${s.total} (${s.rate}%), unresolved ${s.unresolved}, harness errors ${s.errors} — ${repos}; cost $${s.costUsd}`;
  return [...results.map(formatRow), total].join("\n");
}

export function predictions(label: string, results: SweResult[]): string {
  return results.map((r) => `${JSON.stringify({ instance_id: r.id, model_name_or_path: label, model_patch: r.patch })}\n`).join("");
}

export async function writeResults(dir: string, file: Omit<SweResultsFile, "summary" | "instances">, results: SweResult[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${file.startedAt.slice(0, 10)}-swebench-${file.label}`);
  const instances = results.map(({ patch: _patch, ...rest }) => rest);
  const full: SweResultsFile = { ...file, summary: summarize(results), instances };
  await writeFile(`${base}.json`, `${JSON.stringify(full, null, 2)}\n`);
  await writeFile(`${base}.predictions.jsonl`, predictions(file.label, results));
  return `${base}.json`;
}
