import type { ToolCall } from "@stewart/kernel";

/** `RunTerminal` calls on one directory prefix inside `WINDOW` model turns that earn a nudge. */
const SAME_DIR = 5;
const WINDOW = 20;
/** Model turns without a successful file write after which the model is asked to re-plan. */
export const NO_WRITE_TURNS = 40;
const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);
/** A scratch script: a script file under /tmp or hidden in the project root. */
const SCRATCH_SCRIPT = /^(?:\/tmp\/[^\n]*|\.[^/\n]+)\.(?:py|sh|mjs|js|rb)$/;
const PATH_TOKEN = /(?:^|\s)(~?\/[^\s'"`;|&]+)/;

const isAbs = (p: string): boolean => p.startsWith("/") || p.startsWith("~");

/** The directory segments a terminal call works in: its `cwd` argument, else the parent of its first absolute path argument. */
function dirSegments(args: Record<string, unknown>): { lead: string; segs: string[] } | undefined {
  const cwd = typeof args.cwd === "string" && isAbs(args.cwd) ? args.cwd : undefined;
  const tok = cwd ?? (typeof args.command === "string" ? PATH_TOKEN.exec(args.command)?.[1] : undefined);
  if (!tok || !isAbs(tok)) return undefined;
  const segs = tok.split("/").filter((x) => x && x !== ".");
  return { lead: tok.startsWith("/") ? "/" : "", segs: cwd ? segs : segs.slice(0, -1) };
}

/** First 4 directory segments the command works in; undefined when there is none or it is inside `root`. Relative paths are project work, not exploration. */
export function dirPrefix(args: Record<string, unknown>, root?: string): string | undefined {
  const d = dirSegments(args);
  if (!d || d.segs.length < 2) return undefined;
  const prefix = `${d.lead}${d.segs.slice(0, 4).join("/")}`;
  return root && (prefix === root || prefix.startsWith(`${root}/`)) ? undefined : prefix;
}

export interface ExploreOpts {
  /** Project root: terminal calls inside it are ordinary work, not exploration. */
  root?: string;
  /** Whether the role has a file-write tool; read-only roles never get the no-write nudge. */
  canWrite: boolean;
}

/**
 * Exploration discipline for the native loop. Nudges (never trips): ≥ 5 `RunTerminal` calls on the same directory
 * prefix within 20 model turns (once per prefix), and every 40 model turns without a successful file write for a
 * role that can write. Each nudge is a `[Stewart]` message for the transcript.
 */
export class ExploreGuard {
  private turn = 0;
  private sinceWrite = 0;
  private wrote = false;
  private readonly dirs = new Map<string, number[]>();
  private readonly nudged = new Set<string>();
  private scriptNudged = false;

  constructor(private readonly opts: ExploreOpts) {}

  /** One finished tool call; returns a nudge to show the model, if any. */
  record(call: ToolCall, ok: boolean): string | undefined {
    if (ok && WRITE_TOOLS.has(call.name)) this.wrote = true;
    if (call.name === "WriteFile") return ok ? this.scratchScript(call.arguments) : undefined;
    return call.name === "RunTerminal" ? this.sweep(call.arguments) : undefined;
  }

  /** One terminal call: nudge once per directory prefix hit `SAME_DIR` times within `WINDOW` turns. */
  private sweep(args: Record<string, unknown>): string | undefined {
    const prefix = dirPrefix(args, this.opts.root);
    if (!prefix || this.nudged.has(prefix)) return undefined;
    const hits = (this.dirs.get(prefix) ?? []).filter((t) => this.turn - t < WINDOW);
    hits.push(this.turn);
    this.dirs.set(prefix, hits);
    if (hits.length < SAME_DIR) return undefined;
    this.nudged.add(prefix);
    return `[Stewart] ${hits.length} terminal commands on ${prefix} in the last ${WINDOW} turns. Stop sweeping it: summarise what you have learned, make the change with what you know, or ask the user.`;
  }

  /** Once per run: a helper script written to a scratch path gets a pointer to the purpose-built tools. */
  private scratchScript(args: Record<string, unknown>): string | undefined {
    const path = typeof args.path === "string" ? args.path : "";
    if (this.scriptNudged || !SCRATCH_SCRIPT.test(path)) return undefined;
    this.scriptNudged = true;
    return `[Stewart] You wrote a scratch script (${path}). Scratch scripts cost turns and leave files behind: for a project health check call health_batches and delegate the batches; otherwise use Search, FindFiles or ListCodeFiles.`;
  }

  /** Close one model turn; returns the no-write nudge every `NO_WRITE_TURNS` turns without a write. */
  endTurn(): string | undefined {
    this.turn++;
    this.sinceWrite = this.wrote ? 0 : this.sinceWrite + 1;
    this.wrote = false;
    if (!this.opts.canWrite || this.sinceWrite < NO_WRITE_TURNS) return undefined;
    this.sinceWrite = 0;
    return `[Stewart] ${NO_WRITE_TURNS} model turns without a file change. In one line say what you have found so far, then re-plan: make the change now, or ask the user if you are blocked.`;
  }
}
