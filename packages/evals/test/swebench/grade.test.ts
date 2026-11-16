import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grade, statusMap } from "../../src/swebench/grade.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const wrap = (body: string, code = 0): string => `+ : '>>>>> Start Test Output'\n${body}\n+ : '>>>>> End Test Output'\n>>>>> Test Exit Code: ${code}\n`;
const inst = (f2p: string[], p2p: string[], log_parser = "parse_log_pytest") => ({ FAIL_TO_PASS: f2p, PASS_TO_PASS: p2p, log_parser });
const sm = (lines: string[]): string => wrap(lines.join("\n"), lines.some((l) => l.startsWith("FAILED") || l.startsWith("ERROR")) ? 1 : 0);

describe("swebench grade", () => {
  it("resolves the real django gold log, including the test whose ok is separated by migration output", () => {
    const g = grade(
      fixture("django-11099-gold.txt"),
      inst(
        ["test_ascii_validator (auth_tests.test_validators.UsernameValidatorsTests)", "test_unicode_validator (auth_tests.test_validators.UsernameValidatorsTests)"],
        ["test_help_text (auth_tests.test_validators.MinimumLengthValidatorTest)", "test_validate_password (auth_tests.test_validators.PasswordValidationTest)"],
        "parse_log_django",
      ),
    );
    expect(g).toEqual({ status: "resolved", reason: "all FAIL_TO_PASS and PASS_TO_PASS tests pass", f2p: { passed: 2, total: 2 }, p2p: { passed: 2, total: 2 }, failed: [] });
  });

  it("leaves the real django no-patch log unresolved and names the failing id", () => {
    const f2p = "test_autoescape_off (template_tests.test_engine.RenderToStringTest)";
    const g = grade(fixture("django-11119-nopatch.txt"), inst([f2p], ["test_basic_context (template_tests.test_engine.RenderToStringTest)", "test_origin (template_tests.test_engine.LoaderTests)"], "parse_log_django"));
    expect(g.status).toBe("unresolved");
    expect(g.f2p).toEqual({ passed: 0, total: 1 });
    expect(g.p2p).toEqual({ passed: 2, total: 2 });
    expect(g.failed).toEqual([f2p]);
    expect(g.reason).toBe("1 FAIL_TO_PASS and 0 PASS_TO_PASS tests failed");
  });

  it("an expected id missing from the log counts as failed", () => {
    const g = grade(sm(["PASSED t.py::a"]), inst(["t.py::a"], ["t.py::gone"]));
    expect(g.status).toBe("unresolved");
    expect(g.failed).toEqual(["t.py::gone"]);
  });

  it("a skipped test maintains PASS_TO_PASS but does not satisfy FAIL_TO_PASS", () => {
    const log = sm(["PASSED t.py::a", "SKIPPED t.py::s"]);
    expect(grade(log, inst(["t.py::a"], ["t.py::s"])).status).toBe("resolved");
    expect(grade(log, inst(["t.py::s"], ["t.py::a"])).failed).toEqual(["t.py::s"]);
  });

  it("XFAIL counts as passing", () => {
    expect(grade(sm(["XFAIL t.py::x", "PASSED t.py::a"]), inst(["t.py::x"], ["t.py::a"])).status).toBe("resolved");
  });

  it("matches truncated parametrized ids by prefix only when the candidates agree", () => {
    const cut = "t.py::test_x[log(photon";
    expect(grade(sm([`PASSED ${cut}/m**2)]`]), inst([cut], [])).status).toBe("resolved");
    expect(grade(sm(["PASSED t.py::test_x[args1-None]", "XFAIL t.py::test_x[args1-No-value]"]), inst(["t.py::test_x[args1-No"], [])).status).toBe("resolved");
    expect(grade(sm(["PASSED t.py::test_x[args1-None]", "FAILED t.py::test_x[args1-No-value]"]), inst(["t.py::test_x[args1-No"], [])).status).toBe("unresolved");
    expect(grade(sm(["FAILED t.py::test_x[log(photon/m)]"]), inst([cut], [])).status).toBe("unresolved");
    expect(grade(sm(["PASSED t.py::other[x]"]), inst([cut], [])).status).toBe("unresolved");
  });

  it("does not prefix-match a well-formed id or one with a surplus closing bracket", () => {
    expect(grade(sm(["PASSED t.py::test_x[case-1-extended]"]), inst(["t.py::test_x[case-1]"], [])).status).toBe("unresolved");
    expect(grade(sm(["PASSED handles foo] gracefully and more"]), inst(["handles foo] gracefully"], [])).status).toBe("unresolved");
  });

  it("an empty expected list is satisfied", () => {
    expect(grade(sm(["PASSED t.py::a"]), inst([], ["t.py::a"])).status).toBe("resolved");
  });

  it("reports harness faults as errors, not as unresolved", () => {
    const i = inst(["t.py::a"], []);
    expect(grade(">>>>> Patch Apply Failed\n", i)).toMatchObject({ status: "error", reason: "Patch Apply Failed" });
    expect(grade(`${sm(["PASSED t.py::a"])}\n\n>>>>> Tests Timed Out: 60 seconds exceeded.`, i)).toMatchObject({ status: "error", reason: "Tests Timed Out" });
    expect(grade("pip install failed\n", i).reason).toContain("test output markers missing");
    expect(grade(wrap("ImportError: cannot import name x", 2), i)).toMatchObject({ status: "error", reason: "no test results in the log" });
    expect(grade(sm(["PASSED t.py::a"]), inst(["t.py::a"], [], "parse_log_rust"))).toMatchObject({ status: "error", reason: "no log parser 'parse_log_rust' in this harness" });
  });

  it("a non-zero test exit with no failed test in the log is an error", () => {
    const g = grade(wrap("PASSED t.py::a", 1), inst(["t.py::a"], []));
    expect(g).toMatchObject({ status: "error", reason: "test command exited 1 but the log shows no failed test" });
    expect(grade(wrap("PASSED t.py::a\nFAILED t.py::b - boom", 1), inst(["t.py::a"], [])).status).toBe("resolved");
  });

  it("falls back to the whole log when the marked slice has no results, and tolerates a missing exit code", () => {
    const log = "PASSED t.py::a\n+ : '>>>>> Start Test Output'\n\n+ : '>>>>> End Test Output'\n";
    expect(grade(log, inst(["t.py::a"], [])).status).toBe("resolved");
  });

  it("a suite that visibly ran with no parsed status leaves every id failed", () => {
    const g = grade(wrap("Tests:       3 passed, 3 total"), inst(["t.py::a"], []));
    expect(g.status).toBe("unresolved");
    expect(statusMap(wrap("Tests:       3 passed, 3 total"), "parse_log_pytest")).toEqual(new Map());
  });

  it("an id whose parsed status is neither passing nor failing is left out of both tallies", () => {
    const g = grade(wrap("PASSED t.py::b\nERROR: t.py::a boom"), inst(["t.py::a"], ["t.py::b"]));
    expect(g.f2p).toEqual({ passed: 0, total: 0 });
    expect(g.p2p).toEqual({ passed: 1, total: 1 });
    expect(g.status).toBe("resolved");
  });
});
