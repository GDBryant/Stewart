import { describe, expect, it } from "vitest";
import {
  renderMetrics, renderMetricsSummary, scanMetrics, summarizeMetrics,
  type FileMetrics,
} from "../src/api.js";

const TS = `export function add(a: number, b: number): number {
  return a + b;
}

const mul = (a: number, b: number) => {
  if (a === 0 || b === 0) return 0;
  return a * b;
};

class Calc {
  run(x: number): number {
    const r = x ? x : 1;
    return r ?? 0;
  }
}
`;

describe("scanMetrics brace family (TS)", () => {
  it("finds function decl, arrow const and class method", () => {
    const m = scanMetrics("a.ts", TS);
    expect(m.measured).toBe(true);
    expect(m.functions.map((f) => f.name)).toEqual(["add", "mul", "run"]);
    const mul = m.functions[1];
    expect(mul.branches).toBe(2);
    const run = m.functions[2];
    expect(run.branches).toBe(2);
  });

  it("counts a 12-branch function exactly", () => {
    const body = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) y++;`).join("\n");
    const m = scanMetrics("b.ts", `function f(x: number) {\n  let y = 0;\n${body}\n  return y;\n}`);
    expect(m.functions[0].branches).toBe(12);
  });

  it("does not count x?.y or p?: T; counts ?? and ternary", () => {
    const m = scanMetrics("c.ts", `function f(p?: string) {
  const a = p?.length;
  const b = p ?? "x";
  const c = a ? a : 0;
  return c;
}`);
    expect(m.functions[0].branches).toBe(2);
  });

  it("ignores keywords inside strings and comments", () => {
    const src = `function f() {
  const s = "if for while";
  const t = 'if catch';
  const u = \`while for\`;
  // if for while case catch when && || ??
  /* if for */
  return s + t + u;
}`;
    const m = scanMetrics("d.ts", src);
    expect(m.functions[0].branches).toBe(0);
  });

  it("does not report if-blocks or class bodies as functions", () => {
    const names = scanMetrics("a.ts", TS).functions.map((f) => f.name);
    expect(names).not.toContain("if");
    expect(names).not.toContain("Calc");
  });
});

describe("scanMetrics other brace languages", () => {
  it("Kotlin fun and when", () => {
    const m = scanMetrics("A.kt", `fun pick(x: Int): Int {
  return when (x) {
    0 -> 1
    else -> 2
  }
}`);
    expect(m.functions[0].name).toBe("pick");
    expect(m.functions[0].branches).toBe(1);
  });

  it("Java method", () => {
    const m = scanMetrics("A.java", `public class A {
  private int pick(int x) {
    if (x > 0 && x < 9) return x;
    return 0;
  }
}`);
    expect(m.functions[0].name).toBe("pick");
    expect(m.functions[0].branches).toBe(2);
  });

  it("Go func", () => {
    const m = scanMetrics("a.go", `func pick(x int) int {
	for x > 0 {
		x--
	}
	return x
}`);
    expect(m.functions[0].name).toBe("pick");
    expect(m.functions[0].branches).toBe(1);
  });

  it("Rust fn; the ? operator is not a branch", () => {
    const m = scanMetrics("a.rs", `fn pick(x: i32) -> Result<i32, E> {
    let y = try_it()?;
    if y > 0 { Ok(y) } else { Err(E) }
}`);
    expect(m.functions[0].name).toBe("pick");
    expect(m.functions[0].branches).toBe(1);
  });
});

describe("scanMetrics semicolon-less and brace-style headers", () => {
  it("Kotlin without semicolons: nested ifs are control, not functions", () => {
    const m = scanMetrics("A.kt", `fun a() {
  val x = foo(1)
  if (x) {
    if (y) {
      if (z) {
        if (w) {
          g()
        }
      }
    }
  }
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["a"]);
    expect(m.functions[0].depth).toBe(4);
  });

  it("Go if/for with inline semicolons stay control", () => {
    const m = scanMetrics("a.go", `func f() {
	for i := 0; i < n; i++ {
		if err := g(); err != nil {
			return
		}
	}
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["f"]);
    expect(m.functions[0].depth).toBe(2);
  });

  it("no-semicolon JS: if after a statement is control", () => {
    const m = scanMetrics("a.js", `const f = (a) => {
  const y = 1
  if (a) {
    return y
  }
  return 0
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["f"]);
    expect(m.functions[0].depth).toBe(1);
    expect(m.functions[0].branches).toBe(1);
  });

  it("Allman-style C# method and if", () => {
    const m = scanMetrics("A.cs", `class A
{
	void Foo()
	{
		if (x)
		{
			Bar();
		}
	}
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["Foo"]);
    expect(m.functions[0].depth).toBe(1);
  });

  it("Kotlin data class is not a function; its methods are", () => {
    const m = scanMetrics("A.kt", `data class Foo(val x: Int) {
  fun bar() {
    baz()
  }
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["bar"]);
  });

  it("Swift func; guard is neither function nor depth", () => {
    const m = scanMetrics("a.swift", `func pick(x: Int) -> Int {
    guard x > 0 else {
        return 0
    }
    if x > 1 {
        return x
    }
    return 1
}`);
    expect(m.functions.map((f) => f.name)).toEqual(["pick"]);
    expect(m.functions[0].depth).toBe(1);
    expect(m.functions[0].branches).toBe(1);
  });

  it("multi-line TS parameter list: span starts at the signature's first line", () => {
    const m = scanMetrics("a.ts", `export function longSig(
  a: number,
  b: string,
): number {
  return a;
}
`);
    expect(m.functions).toHaveLength(1);
    expect(m.functions[0].name).toBe("longSig");
    expect(m.functions[0].line).toBe(1);
    expect(m.functions[0].lines).toBe(6);
  });
});

describe("scanMetrics depth", () => {
  it("5 nested ifs => depth 5", () => {
    const src = `function f(a: number) {
  if (a > 0) {
    if (a > 1) {
      if (a > 2) {
        if (a > 3) {
          if (a > 4) {
            return true;
          }
        }
      }
    }
  }
  return false;
}`;
    expect(scanMetrics("d.ts", src).functions[0].depth).toBe(5);
  });

  it("else-if chain stays at depth 1", () => {
    const src = `function f(a: number) {
  if (a === 0) {
    return 0;
  } else if (a === 1) {
    return 1;
  } else {
    return 2;
  }
}`;
    expect(scanMetrics("d.ts", src).functions[0].depth).toBe(1);
  });
});

describe("scanMetrics indent family", () => {
  it("Python def span, elif/and/or branches, nested depth 4, comments and triple strings ignored", () => {
    const src = `def f(a):
    # if elif for
    s = """if for while
    elif"""
    if a > 0:
        for i in range(a):
            if i and a or i:
                if i > 2:
                    return i
    elif a < 0:
        return -1
    return 0

def g():
    return 1
`;
    const m = scanMetrics("a.py", src);
    expect(m.functions).toHaveLength(2);
    const f = m.functions[0];
    expect(f.name).toBe("f");
    expect(f.line).toBe(1);
    expect(f.lines).toBe(13);
    expect(f.branches).toBe(7);
    expect(f.depth).toBe(4);
    expect(m.functions[1].name).toBe("g");
  });

  it("Python multi-line signature: span covers the body, branches counted", () => {
    const src = `def foo(
    a,
    b,
) -> int:
    if a and b:
        return 1
    return 0
`;
    const m = scanMetrics("a.py", src);
    expect(m.functions).toHaveLength(1);
    expect(m.functions[0].name).toBe("foo");
    expect(m.functions[0].lines).toBe(7);
    expect(m.functions[0].branches).toBe(2);
    expect(m.functions[0].depth).toBe(1);
  });

  it("Ruby def...end", () => {
    const src = `def pick(x)
  if x > 0
    x
  else
    0
  end
end
`;
    const m = scanMetrics("a.rb", src);
    expect(m.functions[0].name).toBe("pick");
    expect(m.functions[0].lines).toBe(7);
    expect(m.functions[0].branches).toBe(1);
  });
});

describe("scanMetrics suppressions", () => {
  it("reports every pattern family with its line", () => {
    const src = [
      "// @ts-ignore",
      "// @ts-expect-error",
      "// @ts-nocheck",
      "// eslint-disable-next-line",
      "@Suppress(\"all\")",
      "@SuppressWarnings(\"x\")",
      "x = 1  # noqa",
      "x = 1  # type: ignore",
      "# pylint: disable=bad",
      "#[allow(dead_code)]",
      "//nolint",
      "// nolint",
      "#pragma warning disable",
      "// NOSONAR",
      "it.skip(\"t\")",
      "describe.only(\"t\")",
      "xit(\"t\")",
      "xdescribe(\"t\")",
      "@Ignore",
      "@Disabled",
      "@pytest.mark.skip",
      "t.Skip(\"t\")",
    ].join("\n");
    const m = scanMetrics("a.ts", src);
    expect(m.suppressions.map((s) => s.line)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(m.suppressions[0].text).toBe("// @ts-ignore");
  });

  it("clean file => []", () => {
    expect(scanMetrics("a.ts", "const x = 1;").suppressions).toEqual([]);
  });
});

describe("scanMetrics edge cases", () => {
  it("unknown extension is not measured, never throws, suppressions still scanned", () => {
    const m = scanMetrics("README.md", "# title\nno code // eslint-disable here");
    expect(m.measured).toBe(false);
    expect(m.functions).toEqual([]);
    expect(m.suppressions).toHaveLength(1);
  });

  it("empty content => loc 0", () => {
    const m = scanMetrics("a.ts", "");
    expect(m.loc).toBe(0);
    expect(m.measured).toBe(true);
    expect(m.functions).toEqual([]);
  });

  it("loc counts non-empty lines incl a final unterminated line", () => {
    expect(scanMetrics("a.ts", "x\ny\n").loc).toBe(2);
    expect(scanMetrics("a.ts", "x\ny").loc).toBe(2);
  });
});

const fm = (path: string, loc: number, fns: { branches?: number; lines?: number; depth?: number }[] = [], supp = 0): FileMetrics => ({
  path,
  loc,
  measured: true,
  functions: fns.map((f, i) => ({ name: `fn${i}`, line: 1, lines: f.lines ?? 10, branches: f.branches ?? 0, depth: f.depth ?? 0 })),
  suppressions: Array.from({ length: supp }, (_, i) => ({ line: i + 1, text: "s" })),
});

describe("summarizeMetrics", () => {
  it("counts strictly at the boundaries (10 vs 11, 60 vs 61, 500 vs 501)", () => {
    const s = summarizeMetrics([
      fm("a.ts", 500, [{ branches: 10 }, { branches: 11 }, { lines: 60 }, { lines: 61 }]),
      fm("b.ts", 501, [{ branches: 15 }, { branches: 16 }, { depth: 4 }, { depth: 5 }]),
    ]);
    expect(s.branchesOver10).toBe(3);
    expect(s.branchesOver15).toBe(1);
    expect(s.linesOver60).toBe(1);
    expect(s.linesOver120).toBe(0);
    expect(s.depth4).toBe(2);
    expect(s.depth5).toBe(1);
    expect(s.filesOver500).toBe(1);
    expect(s.filesOver1000).toBe(0);
    expect(s.functions).toBe(8);
    expect(s.loc).toBe(1001);
    expect(s.notMeasured).toBe(0);
  });

  it("counts not-measured files and suppressions", () => {
    const s = summarizeMetrics([
      fm("a.ts", 10, [], 2),
      { path: "b.md", loc: 5, measured: false, functions: [], suppressions: [] },
    ]);
    expect(s.notMeasured).toBe(1);
    expect(s.suppressions).toBe(2);
    expect(s.files).toBe(2);
  });
});

describe("renderMetricsSummary / renderMetrics", () => {
  it("renders the one-line summary", () => {
    const s = renderMetricsSummary(summarizeMetrics([fm("a.ts", 100, [{ branches: 12 }])]));
    expect(s).toBe(
      "Measured (lexical scan, approximate): 1 files / 100 LOC · functions 1 · branches >10: 1, >15: 0 · fn lines >60: 0, >120: 0 · nesting >=4: 0, >=5: 0 · files >500 lines: 0, >1000: 0 · suppressions: 0 · not measured: 0",
    );
  });

  it("renders file rows LOC-desc with offender lines and not-measured rows", () => {
    const out = renderMetrics([
      fm("big.ts", 200, [{ branches: 20, lines: 80, depth: 5 }], 1),
      { path: "doc.md", loc: 300, measured: false, functions: [], suppressions: [] },
      fm("small.ts", 50, [{ branches: 1, lines: 5, depth: 1 }]),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("Measured (lexical scan, approximate): 3 files / 550 LOC");
    expect(lines[1]).toBe("doc.md\tLOC 300\tnot measured");
    expect(lines[2]).toBe("big.ts\tLOC 200\tfns 1\tmax branches 20\tmax fn lines 80\tmax depth 5\tsuppressions 1");
    expect(lines[3]).toBe("  big.ts:1 fn0 branches=20 lines=80 depth=5");
    expect(lines[4]).toBe("  big.ts:1 suppression: s");
    expect(lines[5]).toBe("small.ts\tLOC 50\tfns 1\tmax branches 1\tmax fn lines 5\tmax depth 1\tsuppressions 0");
  });

  it("caps offender lines with a [n more offenders] tail", () => {
    const files = [fm("a.ts", 10, Array.from({ length: 5 }, () => ({ branches: 11 })))];
    const out = renderMetrics(files, 3).split("\n");
    expect(out.filter((l) => l.includes("branches="))).toHaveLength(3);
    expect(out[out.length - 1]).toBe("[2 more offenders]");
  });
});
