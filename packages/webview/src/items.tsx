import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import { FieldRow, looksLikeKey, unflatten, useForm, type Field } from "./fields.js";

function itemSecrets(fields: Field[], form: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const f of fields) if (f.kind === "secret" && form[f.key]) secrets[f.key] = form[f.key];
  return secrets;
}

function itemSummary(fields: Field[], form: Record<string, string>): string {
  return fields
    .filter((f) => f.kind !== "secret" && form[f.key] !== undefined && form[f.key] !== "")
    .map((f) => `${f.label}: ${form[f.key]}`)
    .join(" · ");
}

function ItemCardTitle<T extends object>({
  item, form, lead, extra, onRemove, editing, idMissing, onToggle, onSave,
}: {
  item: T;
  form: Record<string, string>;
  lead?: (item: T) => unknown;
  extra?: (item: T) => unknown;
  onRemove?(): void;
  editing: boolean;
  idMissing: boolean;
  onToggle(): void;
  onSave(): void;
}) {
  return (
    <div class="card-title">
      {lead ? lead(item) : null}
      <b>{form.id ?? (item as { id?: string }).id}</b> {extra ? extra(item) : null}
      <span class="spacer" />
      {onRemove ? <button class="deny" onClick={onRemove}>Remove</button> : null}
      <button onClick={onToggle}>{editing ? "Cancel" : "Edit"}</button>
      {editing ? (
        <button class="send" disabled={idMissing} onClick={onSave}>
          Save
        </button>
      ) : null}
    </div>
  );
}

function ItemCardBody({ editing, fields, form, set, modelsFor }: {
  editing: boolean;
  fields: Field[];
  form: Record<string, string>;
  set(k: string, v: string): void;
  modelsFor?: (channelId: string) => string[];
}) {
  if (!editing) return <div class="summary">{itemSummary(fields, form)}</div>;
  return (
    <div class="form">
      {fields.map((f) => (
        <FieldRow key={f.key} field={f} form={form} set={set} modelsFor={modelsFor} />
      ))}
    </div>
  );
}

function ItemCard<T extends object>({
  item, fields, onSave, onRemove, extra, lead, startEditing, modelsFor,
}: {
  item: T;
  fields: Field[];
  onSave(next: T, secrets: Record<string, string>): void;
  onRemove?(): void;
  extra?: (item: T) => unknown;
  lead?: (item: T) => unknown;
  startEditing?: boolean;
  modelsFor?: (channelId: string) => string[];
}) {
  const { form, set } = useForm(item as object);
  const [editing, setEditing] = useState(!!startEditing);
  const idMissing = fields.some((f) => f.key === "id") && !(form.id ?? "").trim();
  const save = () => {
    const merged = { ...(item as object), ...unflatten(form, fields) };
    onSave(merged as T, itemSecrets(fields, form));
    set("apiKey", "");
    setEditing(false);
  };
  const toggle = () => {
    if (editing) set("apiKey", "");
    setEditing(!editing);
  };
  return (
    <div class="card">
      <ItemCardTitle
        item={item} form={form} lead={lead} extra={extra} onRemove={onRemove}
        editing={editing} idMissing={idMissing} onToggle={toggle} onSave={save}
      />
      <ItemCardBody editing={editing} fields={fields} form={form} set={set} modelsFor={modelsFor} />
    </div>
  );
}

export interface ItemsSectionProps<T extends { id: string }> {
  title: string;
  file: string;
  items: T[];
  fields: Field[];
  store: Store;
  empty: T;
  renderExtra?: (item: T, store: Store) => unknown;
  lead?: (item: T) => unknown;
  modelsFor?: (channelId: string) => string[];
}

function saveItems<T>(store: Store, file: string, next: T[]): void {
  store.saveFile(file, stringify({ version: 1, items: next }, null, 2));
}

// An entered API key goes to the IDE secret store; only its ref name is written to YAML.
function attachSecret<T extends { id: string }>(store: Store, next: T, secrets: Record<string, string>): T {
  const key = secrets.apiKey;
  if (!key) return next;
  const o = next as T & { secretRef?: string };
  const ref = o.secretRef && !looksLikeKey(o.secretRef) ? o.secretRef : `channel-${o.id}`;
  store.setSecret(ref, key);
  return { ...o, secretRef: ref };
}

export function ItemsSection<T extends { id: string }>(props: ItemsSectionProps<T>) {
  const { title, file, items, fields, store, empty, renderExtra, lead, modelsFor } = props;
  const extra = renderExtra ? (i: T) => renderExtra(i, store) : undefined;
  const [draft, setDraft] = useState<T | undefined>(undefined);
  return (
    <section>
      <h3>
        {title} <button class="small" onClick={() => setDraft({ ...empty, id: "" })}>+ Add</button>
      </h3>
      {items.map((it) => (
        <ItemCard
          key={it.id}
          item={it}
          fields={fields}
          modelsFor={modelsFor}
          extra={extra}
          lead={lead}
          onSave={(next, sec) => saveItems(store, file, items.map((x) => (x.id === it.id ? attachSecret(store, next, sec) : x)))}
          onRemove={() => saveItems(store, file, items.filter((x) => x.id !== it.id))}
        />
      ))}
      {draft ? (
        <ItemCard
          item={draft}
          fields={fields}
          modelsFor={modelsFor}
          startEditing
          extra={extra}
          lead={lead}
          onSave={(next, sec) => {
            saveItems(store, file, [...items, attachSecret(store, next, sec)]);
            setDraft(undefined);
          }}
          onRemove={() => setDraft(undefined)}
        />
      ) : null}
      {!items.length && !draft ? <p class="hint">None configured.</p> : null}
    </section>
  );
}
