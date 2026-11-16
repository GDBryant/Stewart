import type { Instance } from "./instances.js";
import { parserFor, type StatusMap } from "./logParsers.js";

export const APPLY_PATCH_FAIL = ">>>>> Patch Apply Failed";
export const TESTS_TIMEOUT = ">>>>> Tests Timed Out";
export const START_TEST_OUTPUT = ">>>>> Start Test Output";
export const END_TEST_OUTPUT = ">>>>> End Test Output";
export const TEST_EXIT_CODE = ">>>>> Test Exit Code";
const BAD_CODES = [APPLY_PATCH_FAIL, ">>>>> Reset Failed", ">>>>> Tests Errored", TESTS_TIMEOUT];

const SUITE_RAN =
  /Executed [1-9]\d* of \d+|TOTAL: [1-9]\d* (?:SUCCESS|FAILED)|[1-9]\d* passing|Tests:\s+[1-9]\d*|Test Suites:\s+(?:\d+ \w+, )*[1-9]\d* total|^# tests [1-9]\d*|[1-9]\d* specs?, \d+ failures?|': ok$/m;

export interface Tally {
  passed: number;
  total: number;
}

export interface Grade {
  status: "resolved" | "unresolved" | "error";
  reason: string;
  f2p: Tally;
  p2p: Tally;
  failed: string[];
}

const PASSING = ["PASSED", "XFAIL"];
const FAILING = ["FAILED", "ERROR", "SKIPPED"];

function resolveCase(id: string, sm: StatusMap): string | null {
  if (sm.has(id)) return id;
  if (id.split("[").length <= id.split("]").length) return null;
  const matches = [...sm.keys()].filter((k) => k.startsWith(id));
  const verdicts = new Set(matches.map((k) => PASSING.includes(sm.get(k)!)));
  return matches.length > 0 && verdicts.size === 1 ? matches[0] : null;
}

type Outcome = "pass" | "fail" | "neither";

function outcome(id: string, sm: StatusMap, skippedPasses: boolean): Outcome {
  const key = resolveCase(id, sm);
  if (key === null) return "fail";
  const status = sm.get(key)!;
  if (PASSING.includes(status) || (skippedPasses && status === "SKIPPED")) return "pass";
  return FAILING.includes(status) ? "fail" : "neither";
}

function tally(ids: string[], sm: StatusMap, skippedPasses: boolean): { t: Tally; failed: string[] } {
  const outcomes = ids.map((id) => outcome(id, sm, skippedPasses));
  const failed = ids.filter((_, i) => outcomes[i] === "fail");
  const passed = outcomes.filter((o) => o === "pass").length;
  return { t: { passed, total: passed + failed.length }, failed };
}

function exitCode(content: string): number | null {
  const m = new RegExp(`${TEST_EXIT_CODE}:\\s*(-?\\d+)`).exec(content);
  return m ? Number(m[1]) : null;
}

function nonZeroExitWithoutFailure(content: string, sm: StatusMap): boolean {
  const code = exitCode(content);
  if (code === null || code === 0 || sm.size === 0) return false;
  return ![...sm.values()].some((s) => s === "FAILED" || s === "ERROR");
}

export function statusMap(content: string, parserName: string): StatusMap | string {
  const parse = parserFor(parserName);
  if (!parse) return `no log parser '${parserName}' in this harness`;
  const bad = BAD_CODES.find((c) => content.includes(c));
  if (bad) return bad.replace(/^>+ /, "");
  if (!content.includes(START_TEST_OUTPUT) || !content.includes(END_TEST_OUTPUT)) return "test output markers missing (eval script did not reach the tests)";
  const sliced = content.split(START_TEST_OUTPUT)[1].split(END_TEST_OUTPUT)[0];
  let sm = parse(sliced);
  if (sm.size === 0) sm = parse(content);
  if (sm.size === 0 && !SUITE_RAN.test(content)) return "no test results in the log";
  if (nonZeroExitWithoutFailure(content, sm)) return `test command exited ${exitCode(content)} but the log shows no failed test`;
  return sm;
}

const EMPTY: Tally = { passed: 0, total: 0 };

export function grade(content: string, inst: Pick<Instance, "FAIL_TO_PASS" | "PASS_TO_PASS" | "log_parser">): Grade {
  const sm = statusMap(content, inst.log_parser);
  if (typeof sm === "string") return { status: "error", reason: sm, f2p: EMPTY, p2p: EMPTY, failed: [] };
  const f2p = tally(inst.FAIL_TO_PASS, sm, false);
  const p2p = tally(inst.PASS_TO_PASS, sm, true);
  const failed = [...f2p.failed, ...p2p.failed];
  const resolved = failed.length === 0;
  const reason = resolved ? "all FAIL_TO_PASS and PASS_TO_PASS tests pass" : `${f2p.failed.length} FAIL_TO_PASS and ${p2p.failed.length} PASS_TO_PASS tests failed`;
  return { status: resolved ? "resolved" : "unresolved", reason, f2p: f2p.t, p2p: p2p.t, failed };
}
