import { allOf, anyOf, cmdOk, fail, fileMatches, nodeEval, noChanges, ok, onlyChanged, replyHas, unchanged, type CheckCtx, type CheckFn, type Verdict } from "./kit.js";

export type TaskKind = "question" | "edit" | "report" | "long";

export interface EvalTask {
  id: string;
  kind: TaskKind;
  turns: string[];
  check: CheckFn;
  timeoutMin?: number;
}

const DISCOUNT_TWICE = /twice|double|two times|squared|compound|again|second time|applied .*(both|two)/i;

const lastLineIs = (line: string) => (text: string) => text.trimEnd().split("\n").pop() === line;

function json(rel: string, test: (v: Record<string, unknown>) => boolean, what: string): CheckFn {
  return fileMatches(rel, (t) => {
    try {
      return test(JSON.parse(t) as Record<string, unknown>);
    } catch {
      return false;
    }
  }, what);
}

async function citesExist(c: CheckCtx): Promise<Verdict> {
  const cites = [...(c.replies.at(-1) ?? "").matchAll(/(src\/[\w.-]+\.js):(\d+)/g)];
  if (!cites.length) return fail("no `src/<file>.js:<line>` citations");
  for (const [, path, line] of cites) {
    const text = await c.read(path);
    if (text === null) return fail(`cites missing file ${path}`);
    if (Number(line) > text.split("\n").length) return fail(`cites ${path}:${line} past end of file`);
  }
  return ok(`${cites.length} citations resolve`);
}

const TODO_SCRIPT = [
  'd=$(mktemp -d) && cd "$d"',
  'node "$ROOT/bin/todo.js" add "buy milk"',
  'node "$ROOT/bin/todo.js" add "walk dog"',
  'echo "--list1"',
  'node "$ROOT/bin/todo.js" list',
  'node "$ROOT/bin/todo.js" done 1',
  'echo "--list2"',
  'node "$ROOT/bin/todo.js" list',
].join(" && ");

async function todoCli(c: CheckCtx): Promise<Verdict> {
  const r = await c.sh(TODO_SCRIPT, { env: { ROOT: c.root } });
  if (r.code !== 0) return fail(`todo CLI exited ${r.code}: ${r.out.slice(-600)}`);
  const [, list1 = "", list2 = ""] = r.out.split(/--list[12]\n/);
  const first = /^1\. buy milk$/m.test(list1) && /^2\. walk dog$/m.test(list1);
  const second = /^1\. walk dog$/m.test(list2) && !/buy milk/.test(list2);
  if (!first) return fail(`list after two adds: ${JSON.stringify(list1)}`);
  return second ? ok("todo add/list/done behave") : fail(`list after done 1: ${JSON.stringify(list2)}`);
}

const importCheck = (file: string, body: string) => `const m = await import(process.cwd() + "/${file}"); ${body}`;

export const TASKS: EvalTask[] = [
  {
    id: "q-list-docs",
    kind: "question",
    turns: ["List the files in the docs/ folder."],
    check: allOf(replyHas(-1, /guide\.md/, /api\.md/, /changelog\.md/), noChanges),
  },
  {
    id: "q-no-tools",
    kind: "question",
    turns: ["Without using any tools: what is 17 times 3? Reply with just the number."],
    check: allOf(replyHas(-1, /\b51\b/), noChanges),
  },
  {
    id: "q-explain-function",
    kind: "question",
    turns: ['Explain what parseDuration in src/duration.js does. What does it return for "1h30m"?'],
    check: allOf(replyHas(-1, /\b5,?400\b/, /second/i), noChanges),
  },
  {
    id: "q-find-definition",
    kind: "question",
    turns: ["Which file defines the function applyDiscount?"],
    check: allOf(replyHas(-1, /cart\.js/), noChanges),
  },
  {
    id: "q-summarise-diff",
    kind: "question",
    turns: ["Summarise the changes in the last git commit."],
    check: allOf(replyHas(-1, /truncate/, /strings/), noChanges),
  },
  {
    id: "e-append-line",
    kind: "edit",
    turns: ['Add the line "Licensed under MIT." as the last line of README.md.'],
    check: allOf(
      fileMatches("README.md", lastLineIs("Licensed under MIT."), "ending with the licence line"),
      fileMatches("README.md", (t) => t.startsWith("# shopkit\n") && t.includes("Run the tests with `npm test`."), "keeping its content"),
      onlyChanged("README.md"),
    ),
  },
  {
    id: "e-follow-up",
    kind: "edit",
    turns: ["What port is set in config.json?", "Change it to 9090 and keep everything else the same."],
    check: allOf(
      replyHas(0, /8080/),
      json("config.json", (v) => v.port === 9090 && v.name === "shopkit" && v.debug === false, "port 9090 with other keys kept"),
      onlyChanged("config.json"),
    ),
  },
  {
    id: "e-rename",
    kind: "edit",
    turns: ["Rename the function capitalize to capitalizeFirst everywhere in the project, including its uses and tests."],
    check: allOf(
      nodeEval(importCheck("src/index.js", 'if (typeof m.capitalizeFirst !== "function" || "capitalize" in m) process.exit(1);'), "index exports capitalizeFirst only"),
      cmdOk("! grep -rnw capitalize src test"),
      cmdOk("node --test test/strings.test.js"),
    ),
  },
  {
    id: "e-new-file",
    kind: "edit",
    turns: ['Create src/greet.js that exports a function greet(name) returning "Hello, <name>!".'],
    check: allOf(
      nodeEval(importCheck("src/greet.js", 'const f = typeof m.greet === "function" ? m.greet : m.default; if (typeof f !== "function" || f("Ada") !== "Hello, Ada!") process.exit(1);'), 'greet("Ada") is "Hello, Ada!"'),
      onlyChanged("src/greet.js"),
    ),
  },
  {
    id: "e-fix-failing-test",
    kind: "edit",
    turns: ["test/range.test.js fails. Find and fix the bug in the source code; do not change the test file."],
    check: allOf(cmdOk("node --test test/range.test.js"), unchanged("test/range.test.js")),
  },
  {
    id: "e-function-with-test",
    kind: "edit",
    turns: [
      "Add a function slugify(text) to src/strings.js: lowercase, trim, replace each run of non-alphanumeric characters with a single hyphen, and strip leading and trailing hyphens. Add tests for it in test/strings.test.js.",
    ],
    check: allOf(
      nodeEval(importCheck("src/strings.js", 'if (m.slugify("  Hello, World! ") !== "hello-world" || m.slugify("a--b") !== "a-b") process.exit(1);'), "slugify behaves"),
      fileMatches("test/strings.test.js", (t) => t.includes("slugify"), "testing slugify"),
      cmdOk("node --test test/strings.test.js"),
    ),
  },
  {
    id: "e-two-files",
    kind: "edit",
    turns: ['Bump the version in package.json to 1.1.0, and add a "## 1.1.0" section above "## 1.0.0" in docs/changelog.md that mentions the new truncate helper.'],
    check: allOf(
      json("package.json", (v) => v.version === "1.1.0" && v.name === "shopkit", "version 1.1.0"),
      fileMatches("docs/changelog.md", (t) => /## 1\.1\.0[\s\S]*truncate[\s\S]*## 1\.0\.0/.test(t), "1.1.0 section above 1.0.0 mentioning truncate"),
      onlyChanged("package.json", "docs/changelog.md"),
    ),
  },
  {
    id: "r-review-file",
    kind: "report",
    turns: ["Review src/cart.js for bugs. Report each finding as `path:line — problem`. Do not edit any files."],
    check: allOf(replyHas(-1, /cart\.js/, DISCOUNT_TWICE), noChanges),
  },
  {
    id: "r-review-folder",
    kind: "report",
    turns: ["Review the src/ folder and list concrete bugs, one per line, as `path:line — problem`. Do not edit any files."],
    check: allOf(
      citesExist,
      anyOf(replyHas(-1, /range\.js/, /off.by.one|end - 1|exclud|last (element|item|value)|one short|missing/i), replyHas(-1, /cart\.js/, DISCOUNT_TWICE)),
      noChanges,
    ),
  },
  {
    id: "l-todo-cli",
    kind: "long",
    timeoutMin: 30,
    turns: [
      [
        "Build a small todo CLI in three milestones, and verify each milestone before starting the next:",
        "1. `node bin/todo.js add <text>` appends an item to todo.json in the current working directory (create the file if missing).",
        "2. `node bin/todo.js list` prints the items as `1. <text>`, one per line.",
        "3. `node bin/todo.js done <n>` removes item n.",
        "Add tests in test/todo.test.js that cover all three commands.",
      ].join("\n"),
    ],
    check: allOf(todoCli, fileMatches("test/todo.test.js", (t) => /add/.test(t) && /list/.test(t) && /done/.test(t), "covering add, list and done"), cmdOk("node --test test/todo.test.js")),
  },
];
