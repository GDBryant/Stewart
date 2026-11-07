#!/usr/bin/env node
// Dev helper for module extraction. Usage:
//   node scripts/rewrite-imports.mjs <pkg> <srcFileSuffix> [name,name,...|*] <dir...>
// Rewrites imports that resolve to <srcFileSuffix> (e.g. channels/types.js) in the given dirs so the listed
// names (or all) come from <pkg> instead. Names not listed stay on the original import.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [pkg, suffix, namesArg, ...dirs] = process.argv.slice(2);
const names = namesArg === "*" ? null : new Set(namesArg.split(","));
const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"([^"]*${suffix.replace(/[.]/g, "\\.")})";?`, "g");

function walk(d, acc) {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, acc); else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

let changed = 0;
for (const f of dirs.flatMap((d) => walk(d, []))) {
  const src = readFileSync(f, "utf8");
  const out = src.replace(re, (all, typeKw, list, from) => {
    const items = list.split(",").map((s) => s.trim()).filter(Boolean);
    const base = (s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
    const moved = items.filter((s) => !names || names.has(base(s)));
    const kept = items.filter((s) => !moved.includes(s));
    if (!moved.length) return all;
    const mk = (its, kw, spec) => `import ${kw ?? ""}{ ${its.join(", ")} } from "${spec}";`;
    return [mk(moved, typeKw, pkg), kept.length ? mk(kept, typeKw, from) : ""].filter(Boolean).join("\n");
  });
  if (out !== src) { writeFileSync(f, out); changed++; }
}
console.log(`rewrote ${changed} files`);
