import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeUpdates } from "./sync-tsrefs.mjs";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "tsrefs-"));
  const pkg = (dir, name, deps = {}) => {
    const d = join(root, dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name, dependencies: deps }));
    writeFileSync(join(d, "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist" }, include: ["src"] }));
  };
  pkg("modules/a", "@stewart/a");
  pkg("modules/b", "@stewart/b", { "@stewart/a": "workspace:*" });
  return root;
}

function apply(root, updates) {
  for (const [tp, next] of updates) writeFileSync(tp, JSON.stringify(next, null, 2) + "\n");
}

test("sync writes references and composite, then tree is in sync", () => {
  const root = makeTree();
  const updates = computeUpdates(root);
  assert.equal(updates.size, 2);
  const bTs = updates.get(join(root, "modules/b/tsconfig.json"));
  assert.deepEqual(bTs.references, [{ path: "../a" }]);
  const aTs = updates.get(join(root, "modules/a/tsconfig.json"));
  assert.equal(aTs.compilerOptions.composite, true);
  apply(root, updates);
  assert.equal(computeUpdates(root).size, 0);
});

test("missing reference is detected", () => {
  const root = makeTree();
  apply(root, computeUpdates(root));
  const tp = join(root, "modules/b/tsconfig.json");
  const t = JSON.parse(readFileSync(tp, "utf8"));
  delete t.references;
  writeFileSync(tp, JSON.stringify(t));
  const updates = computeUpdates(root);
  assert.equal(updates.size, 1);
  assert.deepEqual(updates.get(tp).references, [{ path: "../a" }]);
});

test("extra reference is detected", () => {
  const root = makeTree();
  apply(root, computeUpdates(root));
  const tp = join(root, "modules/a/tsconfig.json");
  const t = JSON.parse(readFileSync(tp, "utf8"));
  t.references = [{ path: "../b" }];
  writeFileSync(tp, JSON.stringify(t));
  const updates = computeUpdates(root);
  assert.equal(updates.size, 1);
  assert.equal(updates.get(tp).references, undefined);
});
