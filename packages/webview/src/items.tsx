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

function ItemCard<T extends object>({
  item, fields, onSave, onRemove, extra, startEditing, modelsFor,
}: {
  item: T;
  fields: Field[];
  onSave(next: T, secrets: Record<string, string>): void;
  onRemove?(): void;
  extra?: (item: T) => unknown;
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
  return (
    <div class="card">
      <div class="card-title">
        <b>{form.id ?? (item as { id?: string }).id}</b> {extra ? extra(item) : null}
        <span class="spacer" />
        {onRemove ? <button class="deny" onClick={onRemove}>Remove</button> : null}
        <button onClick={() => { if (editing) set("apiKey", ""); setEditing(!editing); }}>{editing ? "Cancel" : "Edit"}</button>
        {editing ? (
          <button class="send" disabled={idMissing} onClick={save}>
            Save
          </button>
        ) : null}
      </div>
      {editing ? (
        <div class="form">
          {fields.map((f) => (
            <FieldRow key={f.key} field={f} form={form} set={set} modelsFor={modelsFor} />
          ))}
        </div>
      ) : (
        <div class="summary">{itemSummary(fields, form)}</div>
      )}
    </div>
  );
}

export function ItemsSection<T extends { id: string }>({
  title, file, items, fields, store, empty, renderExtra, modelsFor,
}: {
  title: string;
  file: string;
  items: T[];
  fields: Field[];
  store: Store;
  empty: T;
  renderExtra?: (item: T, store: Store) => unknown;
  modelsFor?: (channelId: string) => string[];
}) {
  const save = (next: T[]) => store.saveFile(file, stringify({ version: 1, items: next }, null, 2));
  // An entered API key goes to the IDE secret store; only its ref name is written to YAML.
  const withSecret = (next: T, secrets: Record<string, string>): T => {
    const key = secrets.apiKey;
    if (!key) return next;
    const o = next as T & { secretRef?: string };
    const ref = o.secretRef && !looksLikeKey(o.secretRef) ? o.secretRef : `channel-${o.id}`;
    store.setSecret(ref, key);
    return { ...o, secretRef: ref };
  };
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
          extra={renderExtra ? (i) => renderExtra(i, store) : undefined}
          onSave={(next, sec) => save(items.map((x) => (x.id === it.id ? withSecret(next, sec) : x)))}
          onRemove={() => save(items.filter((x) => x.id !== it.id))}
        />
      ))}
      {draft ? (
        <ItemCard
          item={draft}
          fields={fields}
          modelsFor={modelsFor}
          startEditing
          extra={renderExtra ? (i) => renderExtra(i, store) : undefined}
          onSave={(next, sec) => {
            save([...items, withSecret(next, sec)]);
            setDraft(undefined);
          }}
          onRemove={() => setDraft(undefined)}
        />
      ) : null}
      {!items.length && !draft ? <p class="hint">None configured.</p> : null}
    </section>
  );
}
