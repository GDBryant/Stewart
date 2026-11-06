import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEBUG_LINE_RE, formatDebugLine, type DebugEntry, type DebugSink } from "@stewart/core";

const DAY_MS = 86_400_000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/;

export interface FileDebugSinkOptions {
  /** Log folder announced by the host (`log.dir`); entries are dropped until it is known. */
  dir: () => string | undefined;
  /** 0 keeps everything; N keeps today plus N previous UTC days. */
  retainDays: number;
  now?: () => Date;
  flushMs?: number;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Deletes `yyyy-MM-dd(.N)?.log` files past retention whose first line is a debug-log line. Returns removed names. */
export function pruneDebugLogs(dir: string, today: string, retainDays: number): string[] {
  if (retainDays <= 0) return [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const ageDays = (todayMs - Date.parse(`${m[1]}T00:00:00Z`)) / DAY_MS;
    if (!Number.isFinite(ageDays) || ageDays <= retainDays) continue;
    const path = join(dir, name);
    if (!firstLineIsDebugLog(path)) continue;
    try {
      unlinkSync(path);
      removed.push(name);
    } catch {
      /* unremovable file: keep it */
    }
  }
  return removed;
}

function firstLineIsDebugLog(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    return DEBUG_LINE_RE.test(first);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Debug sink writing `<dir>/yyyy-MM-dd.log` (UTC day, mode 0600). Lines are
 * buffered and appended on a short timer and on exit. Never throws and never
 * writes to stderr: a failed write drops the buffered lines.
 */
export class FileDebugSink implements DebugSink {
  private buf: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey = "";
  private readonly onExit = (): void => this.flush();

  constructor(private opts: FileDebugSinkOptions) {
    process.on("exit", this.onExit);
  }

  record(e: DebugEntry): void {
    try {
      this.buf.push(formatDebugLine({ ...e, ts: e.ts ?? (this.opts.now?.() ?? new Date()) }));
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? 250);
        this.timer.unref?.();
      }
    } catch {
      /* logging never throws */
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buf.length === 0) return;
    const lines = this.buf;
    this.buf = [];
    try {
      const dir = this.opts.dir();
      if (!dir) return;
      const today = utcDay(this.opts.now?.() ?? new Date());
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key = `${dir}\0${today}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        pruneDebugLogs(dir, today, this.opts.retainDays);
      }
      appendFileSync(join(dir, `${today}.log`), `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      /* write failures are dropped */
    }
  }
}
