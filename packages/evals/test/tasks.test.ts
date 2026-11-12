import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCtx } from "../src/kit.js";
import { TASKS } from "../src/tasks.js";
import { prepareRepo } from "../src/workspace.js";

type Solution = { replies: string[]; apply?: (repo: string) => Promise<void> };

const edit = async (repo: string, rel: string, from: string | RegExp, to: string) => {
  const p = join(repo, rel);
  await writeFile(p, (await readFile(p, "utf8")).replace(from, to));
};

const TODO_JS = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = "todo.json";
const items = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "add") items.push(rest.join(" "));
if (cmd === "done") items.splice(Number(rest[0]) - 1, 1);
if (cmd === "list") items.forEach((t, i) => console.log(\`\${i + 1}. \${t}\`));
else writeFileSync(file, JSON.stringify(items));
`;

const TODO_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cli = join(process.cwd(), "bin/todo.js");
test("add, list and done", () => {
  const cwd = mkdtempSync(join(tmpdir(), "todo-"));
  const run = (...a) => execFileSync("node", [cli, ...a], { cwd, encoding: "utf8" });
  run("add", "a");
  run("add", "b");
  assert.equal(run("list"), "1. a\\n2. b\\n");
  run("done", "1");
  assert.equal(run("list"), "1. b\\n");
});
`;

const SOLUTIONS: Record<string, Solution> = {
  "q-list-docs": { replies: ["docs/ has api.md, changelog.md and guide.md."] },
  "q-no-tools": { replies: ["51"] },
  "q-explain-function": { replies: ["It sums h/m/s parts into seconds and throws on junk; '1h30m' gives 5400 seconds."] },
  "q-find-definition": { replies: ["src/cart.js"] },
  "q-summarise-diff": { replies: ["The last commit adds a truncate helper to src/strings.js plus a test."] },
  "e-append-line": { replies: ["done"], apply: async (r) => edit(r, "README.md", /\n$/, "\nLicensed under MIT.\n") },
  "e-follow-up": { replies: ["Port 8080.", "Changed to 9090."], apply: async (r) => edit(r, "config.json", "8080", "9090") },
  "e-rename": {
    replies: ["done"],
    apply: async (r) => {
      for (const f of ["src/strings.js", "src/index.js", "test/strings.test.js"]) await edit(r, f, /\bcapitalize\b/g, "capitalizeFirst");
    },
  },
  "e-new-file": { replies: ["done"], apply: async (r) => writeFile(join(r, "src/greet.js"), "export const greet = (n) => `Hello, ${n}!`;\n") },
  "e-fix-failing-test": { replies: ["done"], apply: async (r) => edit(r, "src/range.js", "end - 1", "end") },
  "e-function-with-test": {
    replies: ["done"],
    apply: async (r) => {
      await writeFile(join(r, "src/strings.js"), `${await readFile(join(r, "src/strings.js"), "utf8")}\nexport function slugify(t) {\n  return t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n`);
      await edit(r, "test/strings.test.js", "import { capitalize, truncate, words }", "import { capitalize, slugify, truncate, words }");
      await writeFile(join(r, "test/strings.test.js"), `${await readFile(join(r, "test/strings.test.js"), "utf8")}\ntest("slugify", () => {\n  assert.equal(slugify(" Hello, World! "), "hello-world");\n});\n`);
    },
  },
  "e-two-files": {
    replies: ["done"],
    apply: async (r) => {
      await edit(r, "package.json", '"1.0.0"', '"1.1.0"');
      await edit(r, "docs/changelog.md", "## 1.0.0", "## 1.1.0\n\n- Add truncate helper.\n\n## 1.0.0");
    },
  },
  "r-review-file": { replies: ["src/cart.js:3 — the discount is applied twice."] },
  "r-review-folder": { replies: ["src/range.js:3 — off-by-one: the loop stops at end - 1.\nsrc/cart.js:3 — discount applied twice."] },
  "l-todo-cli": {
    replies: ["done"],
    apply: async (r) => {
      await mkdir(join(r, "bin"), { recursive: true });
      await writeFile(join(r, "bin/todo.js"), TODO_JS);
      await writeFile(join(r, "test/todo.test.js"), TODO_TEST);
    },
  },
};

const NEGATIVE_REPLIES: Record<string, string[]> = {
  "q-list-docs": ["docs/ has guide.md and api.md."],
  "q-no-tools": ["52"],
  "q-explain-function": ["It parses durations."],
  "q-find-definition": ["src/index.js"],
  "q-summarise-diff": ["Some changes to strings."],
  "r-review-file": ["src/cart.js:3 — no tests."],
  "r-review-folder": ["src/nope.js:3 — discount applied twice."],
};

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evals-test-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  await prepareRepo(repo);
  return repo;
}

describe("fixture", () => {
  it("has exactly the planted failure", async () => {
    const repo = await freshRepo();
    const c = checkCtx(repo, []);
    expect((await c.sh("node --test test/duration.test.js test/strings.test.js")).code).toBe(0);
    expect((await c.sh("node --test test/range.test.js")).code).not.toBe(0);
    expect((await c.sh("git log --oneline")).out.trim().split("\n")).toHaveLength(2);
    expect(await c.changed()).toEqual([]);
  });
});

describe("tasks", () => {
  it("covers every task with a reference solution", () => {
    expect(Object.keys(SOLUTIONS).sort()).toEqual(TASKS.map((t) => t.id).sort());
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });

  for (const task of TASKS) {
    it(`${task.id}: reference solution passes`, async () => {
      const repo = await freshRepo();
      const sol = SOLUTIONS[task.id];
      await sol.apply?.(repo);
      const v = await task.check(checkCtx(repo, sol.replies));
      expect(v, v.evidence).toMatchObject({ pass: true });
    });

    it(`${task.id}: untouched repo or wrong reply fails`, async () => {
      const repo = await freshRepo();
      const replies = NEGATIVE_REPLIES[task.id] ?? task.turns.map(() => "done");
      const v = await task.check(checkCtx(repo, replies));
      expect(v.pass, v.evidence).toBe(false);
    });
  }

  it("question tasks fail when files change", async () => {
    const repo = await freshRepo();
    await edit(repo, "README.md", "shopkit", "shopkit!");
    const task = TASKS.find((t) => t.id === "q-list-docs")!;
    const v = await task.check(checkCtx(repo, SOLUTIONS["q-list-docs"].replies));
    expect(v).toMatchObject({ pass: false });
    expect(v.evidence).toMatch(/README\.md/);
  });

  it("fix-failing-test fails when the test file is edited", async () => {
    const repo = await freshRepo();
    await writeFile(join(repo, "test/range.test.js"), 'import { test } from "node:test";\ntest("x", () => {});\n');
    const task = TASKS.find((t) => t.id === "e-fix-failing-test")!;
    expect((await task.check(checkCtx(repo, ["done"]))).pass).toBe(false);
  });
});
