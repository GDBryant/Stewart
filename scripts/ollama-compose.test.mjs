import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(join(root, "docker/ollama/docker-compose.yml"), "utf8");

test("container_name values are unique across services", () => {
  const names = [...compose.matchAll(/^\s*container_name:\s*(\S+)/gm)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, `duplicate container_name: ${names.join(", ")}`);
});

test("cpu and gpu services get distinct containers", () => {
  assert.match(compose, /ollama:\n(?:.*\n)*?\s*container_name: ollama\n/);
  assert.match(compose, /ollama-gpu:\n(?:.*\n)*?\s*container_name: ollama-gpu\n/);
});
