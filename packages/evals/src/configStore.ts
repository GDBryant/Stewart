import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigLayer, ConfigStore } from "@stewart/core";

const CONFIG_FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"];

async function readSkills(dir: string, layer: ConfigLayer): Promise<void> {
  const names = await readdir(join(dir, "skills")).catch(() => [] as string[]);
  for (const f of names.filter((s) => s.endsWith(".md"))) layer[`skills/${f}`] = await readFile(join(dir, "skills", f), "utf8");
}

/** Config layer backed by a plain directory (same file set as the IDE hosts). */
export function dirStore(dir: string): ConfigStore {
  return {
    read: async () => {
      const layer: ConfigLayer = {};
      for (const f of CONFIG_FILES) {
        const text = await readFile(join(dir, f), "utf8").catch(() => undefined);
        if (text !== undefined) layer[f] = text;
      }
      await readSkills(dir, layer);
      return layer;
    },
    write: async (file, yaml) => {
      const target = join(dir, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(`${target}.tmp`, yaml, "utf8");
      await rename(`${target}.tmp`, target);
    },
    delete: async (file) => rm(join(dir, file), { force: true }),
  };
}
