import type { Json } from "@stewart/kernel";

/** What code verifies after a delegated task: files that must exist, a command that must exit 0. */
export interface DelegateCheck {
  files?: string[];
  command?: string[];
}

export function strings(v: unknown): string[] | undefined {
  const out = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  return out.length ? out : undefined;
}

export function functionSchema(raw: unknown): Json {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("function roles need a schema (JSON Schema object) argument");
  return raw as Json;
}

/** Parse the `check` argument of `delegate`; absent = none. */
export function parseCheck(raw: unknown): DelegateCheck | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("check must be an object {files?, command?}");
  const c = raw as Record<string, unknown>;
  const out = { files: strings(c.files), command: strings(c.command) };
  return out.files || out.command ? out : undefined;
}
