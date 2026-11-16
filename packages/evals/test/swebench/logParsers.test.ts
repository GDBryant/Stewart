import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseLogDjango,
  parseLogMatplotlib,
  parseLogPytest,
  parseLogPytestOptions,
  parseLogPytestV2,
  parseLogSeaborn,
  parseLogSympy,
  parserFor,
} from "../../src/swebench/logParsers.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parserFor", () => {
  it("returns the family parser and undefined for unknown or unsafe names", () => {
    expect(parserFor("parse_log_django")).toBe(parseLogDjango);
    expect(parserFor("parse_log_sympy")).toBe(parseLogSympy);
    expect(parserFor("parse_log_rust")).toBeUndefined();
    expect(parserFor("toString")).toBeUndefined();
  });
});

describe("parseLogSympy (real sympy-13757 no-patch log)", () => {
  const sm = parseLogSympy(fixture("sympy-13757-nopatch.txt"));
  it("marks ok lines PASSED, F FAILED and E ERROR", () => {
    expect(sm.get("test_issue_13079")).toBe("FAILED");
    expect(sm.get("test_issue_4418")).toBe("ERROR");
    expect(sm.get("test__combine_inverse")).toBe("PASSED");
    expect(sm.get("test_Poly_nonzero")).toBe("PASSED");
  });
  it("marks the ____ file.py:test ____ failure header FAILED", () => {
    expect(sm.get("sympy/polys/tests/test_polytools.py:test_issue_13079")).toBe("FAILED");
  });
  it("ignores lowercase outcomes and ids absent from the log", () => {
    expect(sm.has("test_issue_4883")).toBe(false);
    expect(sm.has("test_no_such_test")).toBe(false);
  });
});

describe("parseLogPytestV2 (real sphinx-8120 gold log)", () => {
  const sm = parseLogPytestV2(fixture("sphinx-8120-gold.txt"));
  it("parses status-first and status-last lines", () => {
    expect(sm.get("tests/test_intl.py::test_customize_system_message")).toBe("PASSED");
  });
  it("leaves ids absent from the log unset", () => {
    expect(sm.has("tests/test_intl.py::test_not_in_log")).toBe(false);
  });
});

describe("parseLogPytest (real xarray-4695 gold log)", () => {
  const sm = parseLogPytest(fixture("xarray-4695-gold.txt"));
  it("parses PASSED and FAILED summary lines", () => {
    expect(sm.get("xarray/tests/test_dataarray.py::TestDataArray::test_loc_dim_name_collision_with_sel_params")).toBe("PASSED");
  });
  it("leaves ids absent from the log unset", () => {
    expect(sm.has("xarray/tests/test_dataarray.py::test_not_in_log")).toBe(false);
  });
});

describe("parseLogPytestOptions (real pylint-6528 log)", () => {
  const sm = parseLogPytestOptions(fixture("pylint-6528-log.txt"));
  it("parses parametrized ids and rewrites absolute-path options", () => {
    expect(sm.get("tests/lint/unittest_lint.py::test_recursive_ignore[--ignore-ignored_subdirectory]")).toBe("PASSED");
    expect(sm.get("tests/test_self.py::TestRunTC::test_ignore_recursive")).toBe("PASSED");
  });
  it("leaves ids absent from the log unset", () => {
    expect(sm.has("tests/test_self.py::test_not_in_log")).toBe(false);
  });
});

describe("parseLogMatplotlib (real matplotlib-24570 gold log)", () => {
  const sm = parseLogMatplotlib(fixture("matplotlib-24570-gold.txt"));
  it("parses parametrized packers ids", () => {
    expect(sm.get("lib/matplotlib/tests/test_offsetbox.py::test_packers[bottom]")).toBe("PASSED");
    expect(sm.get("lib/matplotlib/tests/test_offsetbox.py::test_packers[top]")).toBe("PASSED");
  });
  it("ignores the SKIPPED count summary in the real log", () => {
    expect([...sm.keys()].some((k) => k.includes("contextlib"))).toBe(false);
  });
});

describe("parseLogSeaborn (official examples)", () => {
  it("parses both status orders in one log", () => {
    const sm = parseLogSeaborn("test_a.py::test_one PASSED [ 50%]\nPASSED test_b.py::test_two\nFAILED test_c.py::test_three\n");
    expect(sm.get("test_a.py::test_one")).toBe("PASSED");
    expect(sm.get("test_b.py::test_two")).toBe("PASSED");
    expect(sm.get("test_c.py::test_three")).toBe("FAILED");
  });
  it("ignores bare status lines", () => {
    const sm = parseLogSeaborn("PASSED\nFAILED\n PASSED\n");
    expect(sm.size).toBe(0);
  });
});

describe("summary-line edge cases", () => {
  it("ignores SKIPPED count summaries like 'SKIPPED [1] path:12: reason'", () => {
    const sm = parseLogPytest("PASSED t.py::a\nSKIPPED [1] path.py:12: reason\n");
    expect(sm.get("t.py::a")).toBe("PASSED");
    expect(sm.size).toBe(1);
  });
  it("cuts the '- <message>' tail off FAILED ids", () => {
    const sm = parseLogPytest("FAILED a.py::b - assert 1 == 2\n");
    expect(sm.get("a.py::b")).toBe("FAILED");
    expect(sm.size).toBe(1);
  });
});

describe("parseLogPytestOptions option rewriting", () => {
  it("keeps only the basename of a single absolute-path option", () => {
    const sm = parseLogPytestOptions("PASSED t.py::x[/abs/dir/file.txt]\nPASSED t.py::y[//x]\nPASSED t.py::z[/a/*]\n");
    expect(sm.get("t.py::x[/file.txt]")).toBe("PASSED");
    expect(sm.get("t.py::y[//x]")).toBe("PASSED");
    expect(sm.get("t.py::z[/a/*]")).toBe("PASSED");
    expect(sm.size).toBe(3);
  });
});

describe("parseLogPytestV2", () => {
  it("parses old-style 'id STATUS' lines and strips ANSI colour codes", () => {
    const sm = parseLogPytestV2("\x1b[32ma.py::b PASSED\x1b[0m\nFAILED c.py::d - boom\n");
    expect(sm.get("a.py::b")).toBe("PASSED");
    expect(sm.get("c.py::d")).toBe("FAILED");
  });
});

describe("parseLogMatplotlib", () => {
  it("rewrites MouseButton enum members to their codes", () => {
    const sm = parseLogMatplotlib("PASSED t.py::x[MouseButton.LEFT]\nFAILED t.py::y[MouseButton.RIGHT]\n");
    expect(sm.get("t.py::x[1]")).toBe("PASSED");
    expect(sm.get("t.py::y[3]")).toBe("FAILED");
  });
});

describe("parseLogDjango", () => {
  it("parses FAIL:/ERROR: header lines, skipped tests and the --version alias", () => {
    const sm = parseLogDjango(
      [
        "test_x (mod.C) ... skipped 'reason'",
        "FAIL: test_y (mod.C)",
        "ERROR: test_z (mod.C)",
        "--version is equivalent to version",
      ].join("\n"),
    );
    expect(sm.get("test_x (mod.C)")).toBe("SKIPPED");
    expect(sm.get("test_y")).toBe("FAILED");
    expect(sm.get("test_z")).toBe("ERROR");
    expect(sm.get("--version is equivalent to version")).toBe("PASSED");
  });
});
