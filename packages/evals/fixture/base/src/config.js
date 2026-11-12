import { readFileSync } from "node:fs";

export function loadConfig() {
  return JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
}
