import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Shared per-user config dir, identical for every IDE and project:
 * `$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` (win) > `~/.config/stewart`. */
export function sharedUserConfigDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  platform: string = process.platform,
): string {
  if (env.STEWART_CONFIG_DIR) return env.STEWART_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "stewart");
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "stewart");
  return path.join(home, ".config", "stewart");
}

const FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"];

async function copyMissing(from: string, to: string, rel: string): Promise<void> {
  const dst = path.join(to, rel);
  try {
    await fs.access(dst);
    return;
  } catch {
    /* absent: copy */
  }
  let data: string;
  try {
    data = await fs.readFile(path.join(from, rel), "utf8");
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, data, "utf8");
}

/** Create the shared dir (and `skills/`) if absent, and one-time copy any files missing from it out of
 * legacy per-project / per-IDE dirs (earlier dirs win). Never overwrites; never deletes legacy dirs. */
export async function ensureUserConfigDir(dir: string, legacyDirs: string[] = []): Promise<string> {
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  for (const legacy of legacyDirs) {
    if (path.resolve(legacy) === path.resolve(dir)) continue;
    for (const f of FILES) await copyMissing(legacy, dir, f);
    let skills: string[] = [];
    try {
      skills = (await fs.readdir(path.join(legacy, "skills"))).filter((s) => s.endsWith(".md"));
    } catch {
      /* no legacy skills */
    }
    for (const s of skills) await copyMissing(legacy, dir, path.join("skills", s));
  }
  return dir;
}
