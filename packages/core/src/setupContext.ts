import os from "node:os";
import type { HostPort } from "@stewart/kernel";

export interface WorkspaceInfo {
  files: number;
  loc: number;
  languages: Record<string, number>;
  monorepo: boolean;
  sizeClass: "small" | "medium" | "large";
}

export interface HardwareInfo {
  os: string;
  ramGb: number;
  gpus?: { name: string; vramGb: number }[];
}

/** Environment and workload facts gathered once at setup start and handed to both evaluators. */
export interface SetupContext {
  workspace?: WorkspaceInfo;
  hardware?: HardwareInfo;
  /** Wizard sliders, 1–3; absent entries behave as 2. */
  priorities?: { speed: 1 | 2 | 3; cost: 1 | 2 | 3; quality: 1 | 2 | 3 };
  typicalWork?: "scripts" | "features" | "refactors" | "mixed";
}

export const SCAN_FILE_CAP = 20_000;
export const SCAN_DEADLINE_MS = 2_000;
const READ_SIZE_CAP = 256 * 1024;

const LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  kt: "Kotlin", kts: "Kotlin", java: "Java", py: "Python", rs: "Rust", go: "Go",
  rb: "Ruby", cs: "C#", cpp: "C++", cc: "C++", cxx: "C++", c: "C", h: "C", hpp: "C++",
  swift: "Swift", php: "PHP", scala: "Scala", md: "Markdown",
  yaml: "YAML", yml: "YAML", json: "JSON", toml: "TOML", xml: "XML",
  html: "HTML", css: "CSS", sh: "Shell", sql: "SQL",
};

const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"];

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

function countLines(text: string): number {
  if (!text) return 0;
  return (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

/**
 * Counts files, languages and lines across the workspace listing (hosts already
 * skip dot-dirs and node_modules). Reading is capped by file size and a wall
 * deadline; it never looks at contents beyond line counting.
 */
export async function scanWorkspace(host: HostPort, now: () => number = () => Date.now()): Promise<WorkspaceInfo> {
  const all = await host.files.list(".");
  const files = all.slice(0, SCAN_FILE_CAP);
  const languages: Record<string, number> = {};
  const deadline = now() + SCAN_DEADLINE_MS;
  let loc = 0;
  let packageJsons = 0;
  for (const f of files) {
    if (f.endsWith("package.json")) packageJsons++;
    const lang = LANGS[extOf(f)];
    if (!lang) continue;
    languages[lang] = (languages[lang] ?? 0) + 1;
    if (now() >= deadline) continue;
    try {
      if ((await host.files.stat(f)).size > READ_SIZE_CAP) continue;
      loc += countLines((await host.files.read(f)).content);
    } catch {
      /* unreadable or vanished file: counted, not read */
    }
  }
  const monorepo = MONOREPO_MARKERS.some((m) => all.includes(m)) || packageJsons >= 3;
  const sizeClass: WorkspaceInfo["sizeClass"] =
    all.length >= SCAN_FILE_CAP || loc > 2_000_000 || files.length > 10_000
      ? "large"
      : files.length < 2_000 && loc < 200_000
        ? "small"
        : "medium";
  return { files: files.length, loc, languages, monorepo, sizeClass };
}

async function detectGpus(host: HostPort): Promise<{ name: string; vramGb: number }[] | undefined> {
  try {
    let out = "";
    const h = host.proc.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], {
      cwd: ".",
      onData: (d) => {
        out += d;
      },
    });
    const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5_000));
    if ((await Promise.race([h.done.then((d) => d.code), timeout])) === "timeout") {
      await h.killTree().catch(() => {});
      return undefined;
    }
    const { code } = await h.done;
    if (code !== 0) return undefined;
    const gpus = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, mem] = l.split(",").map((s) => s.trim());
        return { name, vramGb: Math.round((parseFloat(mem) / 1024) * 10) / 10 };
      })
      .filter((g) => g.name && Number.isFinite(g.vramGb));
    return gpus.length ? gpus : undefined;
  } catch {
    return undefined;
  }
}

/** OS/RAM plus best-effort NVIDIA detection. Never fails — detection errors leave fields out. */
export async function gatherHardware(host: HostPort): Promise<HardwareInfo> {
  const gpus = await detectGpus(host);
  return {
    os: process.platform,
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    ...(gpus ? { gpus } : {}),
  };
}
