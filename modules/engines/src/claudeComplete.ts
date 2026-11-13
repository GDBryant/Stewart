import { normalizeModel } from "@stewart/catalog";
import { claudeChildEnv, nodeSpawn } from "@stewart/channels";
import { validateArgs } from "@stewart/tools";
import type { Json } from "@stewart/kernel";
import type { ClaudeCodeDeps, CompleteRequest, CompleteResult } from "./types.js";
import { num, obj, str, type Obj } from "./claudeLines.js";

const FENCED = /```(?:json)?\s*\n([\s\S]*?)```/;

/** One function-task request: `claude -p --json-schema`, no tools, no MCP. */
function completeArgv(req: CompleteRequest): string[] {
  const a = [
    (req.channel.cfg.cliPath as string | undefined) ?? "claude",
    "-p", "--output-format", "json", "--tools", "",
    "--json-schema", JSON.stringify(req.schema),
    "--model", normalizeModel(req.agent.model),
    "--setting-sources", (req.channel.cfg.settingSources as string | undefined) ?? "",
  ];
  if (req.system.trim()) a.push("--append-system-prompt", req.system);
  a.push(req.input);
  return a;
}

/** The reply object: `structured_output` when the CLI produced one, else `result` parsed as JSON. */
function structured(res: Obj): Json | string {
  const so = obj(res.structured_output);
  if (so) return so as Json;
  const body = (str(res.result) ?? "").trim();
  for (const c of [body, FENCED.exec(body)?.[1], body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Json;
    } catch { /* next candidate */ }
  }
  return "reply is not a JSON object";
}

async function drain(proc: { stdout: AsyncIterable<string>; done: Promise<unknown>; kill(): Promise<unknown> }, signal: AbortSignal): Promise<string> {
  const onAbort = () => void proc.kill();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  let line = "";
  try {
    for await (const l of proc.stdout) line = l;
    await proc.done;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return line;
}

function usageOf(res: Obj): { in: number; out: number } {
  const u = obj(res.usage);
  const inTok = (num(u?.input_tokens) ?? 0) + (num(u?.cache_creation_input_tokens) ?? 0) + (num(u?.cache_read_input_tokens) ?? 0);
  return { in: inTok, out: num(u?.output_tokens) ?? 0 };
}

function parseResult(line: string, schema: Json): CompleteResult {
  let res: Obj | undefined;
  try {
    res = obj(JSON.parse(line));
  } catch {
    res = undefined;
  }
  if (!res) return { ok: false, error: "no result from Claude CLI" };
  if (res.is_error === true) return { ok: false, error: str(res.result) || "claude error" };
  const v = structured(res);
  if (typeof v === "string") return { ok: false, error: v };
  const bad = validateArgs(v, schema, "function reply");
  if (bad) return { ok: false, error: bad };
  return { ok: true, value: v, usage: usageOf(res), costUsd: num(res.total_cost_usd) };
}

export async function claudeComplete(req: CompleteRequest, deps: ClaudeCodeDeps = {}): Promise<CompleteResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const argv = completeArgv(req);
  let proc;
  try {
    proc = spawn(argv, { cwd: "/", env: claudeChildEnv(req.channel.cfg, deps.env ?? (process.env as Record<string, string | undefined>)) });
  } catch (e) {
    return { ok: false, error: `cannot start Claude CLI at ${argv[0]}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const line = await drain(proc, req.signal);
  return req.signal.aborted ? { ok: false, error: "cancelled" } : parseResult(line, req.schema);
}
