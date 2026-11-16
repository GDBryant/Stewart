export type TestStatus = "FAILED" | "PASSED" | "SKIPPED" | "ERROR" | "XFAIL";
export type StatusMap = Map<string, string>;
export type LogParser = (log: string) => StatusMap;

const STATUSES: readonly TestStatus[] = ["FAILED", "PASSED", "SKIPPED", "ERROR", "XFAIL"];

const words = (line: string): string[] => line.split(/\s+/).filter((w) => w.length > 0);
const startsWithStatus = (line: string): boolean => STATUSES.some((s) => line.startsWith(s));

function isSkipSummary(status: string, name: string): boolean {
  return status === "SKIPPED" && /^\[\d+\]$/.test(name);
}

function summaryLine(line: string): [string, string] | null {
  if (!startsWithStatus(line)) return null;
  const tc = words(line.startsWith("FAILED") ? line.replaceAll(" - ", " ") : line);
  if (tc.length <= 1 || isSkipSummary(tc[0], tc[1])) return null;
  return [tc[0], tc[1]];
}

export function parseLogPytest(log: string): StatusMap {
  const map: StatusMap = new Map();
  for (const line of log.split("\n")) {
    const s = summaryLine(line);
    if (s) map.set(s[1], s[0]);
  }
  return map;
}

function optionName(id: string): string {
  const m = /(.*?)\[(.*)\]/.exec(id);
  if (!m) return id;
  let option = m[2];
  if (option.startsWith("/") && !option.startsWith("//") && !option.includes("*")) option = `/${option.split("/").pop()}`;
  return `${m[1]}[${option}]`;
}

export function parseLogPytestOptions(log: string): StatusMap {
  const map: StatusMap = new Map();
  for (const line of log.split("\n")) {
    const s = summaryLine(line);
    if (s) map.set(optionName(s[1]), s[0]);
  }
  return map;
}

function v2Line(raw: string, map: StatusMap): void {
  let line = raw.replace(/\[(\d+)m/g, "").replace(/[\x01-\x1f]/g, "");
  if (startsWithStatus(line)) {
    if (line.startsWith("FAILED")) line = line.split(" - ")[0];
    const tc = words(line);
    if (tc.length >= 2 && !isSkipSummary(tc[0], tc[1])) map.set(tc.slice(1).join(" "), tc[0]);
    return;
  }
  if (STATUSES.some((s) => line.endsWith(s))) {
    const tc = words(line);
    if (tc.length >= 2) map.set(tc.slice(0, -1).join(" "), tc[tc.length - 1]);
  }
}

export function parseLogPytestV2(log: string): StatusMap {
  const map: StatusMap = new Map();
  for (const line of log.split("\n")) v2Line(line, map);
  return map;
}

const DJANGO_PASS = [" ... ok", " ... OK", " ...  OK"];
const DJANGO_INTERRUPTED = [
  /^(.*?)\s\.\.\.\sTesting against Django installed in ([\s\S]*?) silenced\)\.\nok$/gm,
  /^(.*?)\s\.\.\.\sInternal Server Error: \/(.*)\/\nok$/gm,
  /^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$/gm,
];

function djangoPass(line: string, map: StatusMap): void {
  const suffix = DJANGO_PASS.find((s) => line.endsWith(s));
  if (suffix === undefined) return;
  let l = line;
  if (l.startsWith("Applying sites.0002_alter_domain_unique...test_no_migrations")) l = l.slice(l.indexOf("...") + 3).trim();
  map.set(l.slice(0, l.lastIndexOf(suffix)), "PASSED");
}

function djangoFail(line: string, map: StatusMap): void {
  if (line.includes(" ... skipped")) map.set(line.split(" ... skipped")[0], "SKIPPED");
  if (line.endsWith(" ... FAIL")) map.set(line.split(" ... FAIL")[0], "FAILED");
  if (line.startsWith("FAIL:") && words(line).length > 1) map.set(words(line)[1], "FAILED");
  if (line.endsWith(" ... ERROR")) map.set(line.split(" ... ERROR")[0], "ERROR");
  if (line.startsWith("ERROR:") && words(line).length > 1) map.set(words(line)[1], "ERROR");
}

export function parseLogDjango(log: string): StatusMap {
  const map: StatusMap = new Map();
  let prev: string | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (line.includes("--version is equivalent to version")) map.set("--version is equivalent to version", "PASSED");
    if (line.includes(" ... ")) prev = line.split(" ... ")[0];
    djangoPass(line, map);
    djangoFail(line, map);
    if (line.startsWith("ok") && prev !== null) map.set(prev, "PASSED");
  }
  for (const re of DJANGO_INTERRUPTED) {
    for (const m of log.matchAll(re)) map.set(m[1], "PASSED");
  }
  return map;
}

function seabornLine(line: string, map: StatusMap): void {
  const parts = words(line);
  if (parts.length < 2) return;
  if (line.startsWith("FAILED")) map.set(parts[1], "FAILED");
  else if (line.includes(" PASSED ")) {
    if (parts[1] === "PASSED") map.set(parts[0], "PASSED");
  } else if (line.startsWith("PASSED")) map.set(parts[1], "PASSED");
}

export function parseLogSeaborn(log: string): StatusMap {
  const map: StatusMap = new Map();
  for (const line of log.split("\n")) seabornLine(line, map);
  return map;
}

const SYMPY_SUFFIX: [string, TestStatus][] = [
  [" E", "ERROR"],
  [" F", "FAILED"],
  [" ok", "PASSED"],
];

export function parseLogSympy(log: string): StatusMap {
  const map: StatusMap = new Map();
  for (const m of log.matchAll(/(_*) (.*)\.py:(.*) (_*)/g)) map.set(`${m[2]}.py:${m[3]}`, "FAILED");
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("test_")) continue;
    for (const [suffix, status] of SYMPY_SUFFIX) {
      if (line.endsWith(suffix)) map.set(words(line)[0], status);
    }
  }
  return map;
}

export function parseLogMatplotlib(log: string): StatusMap {
  return parseLogPytest(log.replaceAll("MouseButton.LEFT", "1").replaceAll("MouseButton.RIGHT", "3"));
}

const REGISTRY: Record<string, LogParser> = {
  parse_log_astropy: parseLogPytestV2,
  parse_log_django: parseLogDjango,
  parse_log_flask: parseLogPytest,
  parse_log_matplotlib: parseLogMatplotlib,
  parse_log_pylint: parseLogPytestOptions,
  parse_log_pytest: parseLogPytest,
  parse_log_requests: parseLogPytestOptions,
  parse_log_scikit: parseLogPytestV2,
  parse_log_seaborn: parseLogSeaborn,
  parse_log_sphinx: parseLogPytestV2,
  parse_log_sympy: parseLogSympy,
  parse_log_xarray: parseLogPytest,
};

export function parserFor(name: string): LogParser | undefined {
  return Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
}
