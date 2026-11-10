import type { FileMetrics, MetricsSummary, Suppression } from "./types.js";
import { measuredFamily, scanBrace, scanIndent } from "./scan.js";

const SUPPRESSION_RES = [
  /@ts-ignore/, /@ts-expect-error/, /@ts-nocheck/, /eslint-disable/,
  /@Suppress\(/, /@SuppressWarnings/, /# noqa/, /# type: ignore/, /pylint: disable/,
  /#\[allow\(/, /\/\/\s?nolint/, /#pragma warning disable/, /NOSONAR/,
  /\.skip\(/, /\.only\(/, /\bxit\(/, /\bxdescribe\(/, /@Ignore/, /@Disabled/,
  /@pytest\.mark\.skip/, /\bt\.Skip\(/,
];

function scanSuppressions(lines: string[]): Suppression[] {
  const out: Suppression[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SUPPRESSION_RES.some((re) => re.test(lines[i]))) out.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
  }
  return out;
}

/** Lexical source scan; approximate by design. Unknown extension => not measured, suppressions still scanned. */
export function scanMetrics(path: string, content: string): FileMetrics {
  const raw = content.split("\n");
  const loc = content.length === 0 ? 0 : raw.length - (content.endsWith("\n") ? 1 : 0);
  const suppressions = scanSuppressions(raw);
  try {
    const fam = measuredFamily(path);
    const functions = fam === "none" ? [] : fam === "indent" ? scanIndent(content, path.endsWith(".rb")) : scanBrace(content);
    return { path, loc, measured: fam !== "none", functions, suppressions };
  } catch {
    return { path, loc, measured: false, functions: [], suppressions };
  }
}

export function summarizeMetrics(files: FileMetrics[]): MetricsSummary {
  const s: MetricsSummary = {
    files: files.length, loc: 0, notMeasured: 0, functions: 0,
    branchesOver10: 0, branchesOver15: 0, linesOver60: 0, linesOver120: 0,
    depth4: 0, depth5: 0, filesOver500: 0, filesOver1000: 0, suppressions: 0,
  };
  for (const f of files) {
    s.loc += f.loc;
    if (!f.measured) {
      s.notMeasured++;
      continue;
    }
    s.functions += f.functions.length;
    s.suppressions += f.suppressions.length;
    if (f.loc > 500) s.filesOver500++;
    if (f.loc > 1000) s.filesOver1000++;
    for (const fn of f.functions) {
      if (fn.branches > 10) s.branchesOver10++;
      if (fn.branches > 15) s.branchesOver15++;
      if (fn.lines > 60) s.linesOver60++;
      if (fn.lines > 120) s.linesOver120++;
      if (fn.depth >= 4) s.depth4++;
      if (fn.depth >= 5) s.depth5++;
    }
  }
  return s;
}

export function renderMetricsSummary(s: MetricsSummary): string {
  return `Measured (lexical scan, approximate): ${s.files} files / ${s.loc} LOC · functions ${s.functions} · branches >10: ${s.branchesOver10}, >15: ${s.branchesOver15} · fn lines >60: ${s.linesOver60}, >120: ${s.linesOver120} · nesting >=4: ${s.depth4}, >=5: ${s.depth5} · files >500 lines: ${s.filesOver500}, >1000: ${s.filesOver1000} · suppressions: ${s.suppressions} · not measured: ${s.notMeasured}`;
}

function fileRow(f: FileMetrics): string {
  if (!f.measured) return `${f.path}\tLOC ${f.loc}\tnot measured`;
  const mx = (k: "branches" | "lines" | "depth") => f.functions.reduce((m, fn) => Math.max(m, fn[k]), 0);
  return `${f.path}\tLOC ${f.loc}\tfns ${f.functions.length}\tmax branches ${mx("branches")}\tmax fn lines ${mx("lines")}\tmax depth ${mx("depth")}\tsuppressions ${f.suppressions.length}`;
}

export function renderMetrics(files: FileMetrics[], maxOffenders = 200): string {
  const lines = [renderMetricsSummary(summarizeMetrics(files))];
  let offenders = 0;
  let skipped = 0;
  const offender = (s: string): void => {
    if (offenders < maxOffenders) {
      lines.push(`  ${s}`);
      offenders++;
    } else skipped++;
  };
  for (const f of [...files].sort((a, b) => b.loc - a.loc)) {
    lines.push(fileRow(f));
    for (const fn of f.functions) {
      if (fn.branches > 10 || fn.lines > 60 || fn.depth >= 4) {
        offender(`${f.path}:${fn.line} ${fn.name} branches=${fn.branches} lines=${fn.lines} depth=${fn.depth}`);
      }
    }
    for (const s of f.suppressions) offender(`${f.path}:${s.line} suppression: ${s.text}`);
  }
  if (skipped > 0) lines.push(`[${skipped} more offenders]`);
  return lines.join("\n");
}
