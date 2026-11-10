import { useState } from "preact/hooks";
import type { FunctionComponent } from "preact";

export type Field = {
  key: string;
  label: string;
  kind?: "text" | "bool" | "number" | "list" | "select" | "model" | "secret";
  options?: string[];
  placeholder?: string;
};

export function useForm<T extends object>(initial: T) {
  const [form, setForm] = useState<Record<string, string>>(flatten(initial));
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });
  return { form, set };
}

function flatten(obj: object, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v as object, `${prefix}${k}.`));
    else if (Array.isArray(v)) out[`${prefix}${k}`] = v.join(", ");
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

function coerceField(f: Field, raw: string): { has: boolean; value?: unknown } {
  if (f.kind === "bool") return { has: true, value: raw === "true" };
  if (f.kind === "number") return { has: true, value: Number(raw) };
  if (f.kind === "list") return { has: true, value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
  if (f.kind === "select" || f.kind === "model" || !f.kind) return { has: true, value: raw };
  return { has: false };
}

export function unflatten(form: Record<string, string>, fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = form[f.key];
    if (raw === undefined || raw === "") continue;
    const parts = f.key.split(".");
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= {}) as Record<string, unknown>;
    const leaf = parts[parts.length - 1];
    const c = coerceField(f, raw);
    if (c.has) node[leaf] = c.value;
  }
  return out;
}

type FieldControlKind = "select" | "model" | "secret" | "bool" | "text";
type FieldControlProps = {
  field: Field;
  form: Record<string, string>;
  set: (key: string, value: string) => void;
  modelsFor?: (channelId: string) => string[];
};

function controlKind(f: Field): FieldControlKind {
  return f.kind === "select" || f.kind === "model" || f.kind === "secret" || f.kind === "bool" ? f.kind : "text";
}

const FIELD_CONTROLS: Record<FieldControlKind, FunctionComponent<FieldControlProps>> = {
  select: ({ field: f, form, set }) => (
    <select value={form[f.key] ?? ""} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
      <option value="">—</option>
      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ),
  model: ({ field: f, form, set, modelsFor }) => (
    <select value={form[f.key] ?? ""} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
      <option value="">—</option>
      {[...new Set([...(modelsFor?.(form.channel ?? "") ?? []), ...(form[f.key] ? [form[f.key]] : [])])].map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  ),
  secret: ({ field: f, form, set }) => (
    <input type="password" autocomplete="off" value={form[f.key] ?? ""} placeholder={f.placeholder} onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)} />
  ),
  bool: ({ field: f, form, set }) => (
    <select value={form[f.key] ?? "false"} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  ),
  text: ({ field: f, form, set }) => (
    <input value={form[f.key] ?? ""} placeholder={f.placeholder} onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)} />
  ),
};

export function FieldRow({ field, form, set, modelsFor }: FieldControlProps) {
  const Control = FIELD_CONTROLS[controlKind(field)];
  return (
    <label class="field">
      <span>{field.label}</span>
      <Control field={field} form={form} set={set} modelsFor={modelsFor} />
    </label>
  );
}

/** A secretRef is a short name; a pasted API key is not. */
export function looksLikeKey(ref: string): boolean {
  return ref.length >= 32 || /^(sk|rk|pk|ghp|xox[a-z])[-_]/i.test(ref);
}
