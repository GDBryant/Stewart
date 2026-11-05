import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { ChannelSummary, AgentSummary, RoleSummary, SettingsSummary, ConfigReply } from "./bridge.js";

type Field = {
  key: string;
  label: string;
  kind?: "text" | "bool" | "number" | "list" | "select";
  options?: string[];
  placeholder?: string;
};

function useForm<T extends object>(initial: T) {
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

function unflatten(form: Record<string, string>, fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = form[f.key];
    if (raw === undefined || raw === "") continue;
    const parts = f.key.split(".");
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= {}) as Record<string, unknown>;
    const leaf = parts[parts.length - 1];
    if (f.kind === "bool") node[leaf] = raw === "true";
    else if (f.kind === "number") node[leaf] = Number(raw);
    else if (f.kind === "list") node[leaf] = raw.split(",").map((s) => s.trim()).filter(Boolean);
    else if (f.kind === "select" || !f.kind) node[leaf] = raw;
  }
  return out;
}

function ItemCard<T extends object>({
  item, fields, onSave, onRemove, extra,
}: {
  item: T;
  fields: Field[];
  onSave(next: T): void;
  onRemove?(): void;
  extra?: (item: T) => unknown;
}) {
  const { form, set } = useForm(item as object);
  const [editing, setEditing] = useState(false);
  return (
    <div class="card">
      <div class="card-title">
        <b>{(item as { id?: string }).id}</b> {extra ? extra(item) : null}
        <span class="spacer" />
        {onRemove ? <button class="deny" onClick={onRemove}>Remove</button> : null}
        <button onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
        {editing ? (
          <button
            class="send"
            onClick={() => {
              const merged = { ...(item as object), ...unflatten(form, fields) };
              onSave(merged as T);
              setEditing(false);
            }}
          >
            Save
          </button>
        ) : null}
      </div>
      {editing ? (
        <div class="form">
          {fields.map((f) => (
            <label key={f.key} class="field">
              <span>{f.label}</span>
              {f.kind === "select" ? (
                <select value={form[f.key] ?? ""} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
                  <option value="">—</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.kind === "bool" ? (
                <select value={form[f.key] ?? "false"} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input value={form[f.key] ?? ""} placeholder={f.placeholder} onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)} />
              )}
            </label>
          ))}
        </div>
      ) : (
        <div class="summary">{fields.filter((f) => form[f.key] !== undefined && form[f.key] !== "").map((f) => `${f.label}: ${form[f.key]}`).join(" · ")}</div>
      )}
    </div>
  );
}

function ItemsSection<T extends { id: string }>({
  title, file, items, fields, store, empty, renderExtra,
}: {
  title: string;
  file: string;
  items: T[];
  fields: Field[];
  store: Store;
  empty: T;
  renderExtra?: (item: T, store: Store) => unknown;
}) {
  const save = (next: T[]) => store.saveFile(file, stringify({ version: 1, items: next }, null, 2));
  return (
    <section>
      <h3>
        {title} <button class="small" onClick={() => save([...items, { ...empty, id: `${empty.id || "new"}-${items.length + 1}` }])}>+ Add</button>
      </h3>
      {items.map((it) => (
        <ItemCard
          key={it.id}
          item={it}
          fields={fields}
          extra={renderExtra ? (i) => renderExtra(i, store) : undefined}
          onSave={(next) => save(items.map((x) => (x.id === it.id ? next : x)))}
          onRemove={() => save(items.filter((x) => x.id !== it.id))}
        />
      ))}
      {!items.length ? <p class="hint">None configured.</p> : null}
    </section>
  );
}

const CHANNEL_FIELDS: Field[] = [
  { key: "id", label: "id" },
  { key: "name", label: "name" },
  { key: "type", label: "type", kind: "select", options: ["openai-compatible", "ollama", "claude-cli"] },
  { key: "enabled", label: "enabled", kind: "bool" },
  { key: "baseUrl", label: "baseUrl", placeholder: "http://localhost:11434" },
  { key: "secretRef", label: "secretRef", placeholder: "ref name (stored in IDE secrets)" },
  { key: "extraModels", label: "extraModels (csv)", kind: "list" },
  { key: "maxParallel", label: "maxParallel", kind: "number" },
];
const AGENT_FIELDS: Field[] = [
  { key: "id", label: "id" },
  { key: "channel", label: "channel" },
  { key: "model", label: "model" },
  { key: "effort", label: "effort", kind: "select", options: ["low", "medium", "high", "max"] },
  { key: "temperature", label: "temperature", kind: "number" },
  { key: "billing", label: "billing", kind: "select", options: ["free", "reported", "priced", "unmetered"] },
];
const ROLE_FIELDS: Field[] = [
  { key: "id", label: "id" },
  { key: "enabled", label: "enabled", kind: "bool" },
  { key: "agent", label: "agent" },
  { key: "fallbackAgent", label: "fallback agent" },
  { key: "skills", label: "skills (csv)", kind: "list" },
  { key: "tools", label: "tools (csv)", kind: "list" },
  { key: "writePaths", label: "writePaths (csv)", kind: "list" },
  { key: "turnBudget", label: "turnBudget", placeholder: "number or unlimited" },
];
const SETTINGS_FIELDS: Field[] = [
  { key: "costLimit.perRunUsd", label: "cost limit $/run", kind: "number" },
  { key: "costLimit.onLimit", label: "on limit", kind: "select", options: ["ask", "stop"] },
  { key: "maxRunHours", label: "max run hours", kind: "number" },
  { key: "leaseWaitSeconds", label: "lease wait s", kind: "number" },
  { key: "maxNestedDispatches", label: "max nested dispatches", kind: "number" },
  { key: "maxReplans", label: "max replans", kind: "number" },
  { key: "skillBudgetTokens", label: "skill budget tokens", kind: "number" },
  { key: "log.level", label: "log level", kind: "select", options: ["off", "calls", "full"] },
  { key: "log.retainDays", label: "log retain days", kind: "number" },
];

function ChannelExtra({ item, store }: { item: ChannelSummary; store: Store }) {
  const test = store.state.channelTest[item.id];
  return (
    <span class="extra">
      {test ? (test.ok ? <span class="ok">✓ {(test.models ?? []).join(", ")}</span> : <span class="fail">✗ {test.error}</span>) : null}
      <button class="small" onClick={() => store.testChannel(item.id)}>Test</button>
      {item.secretRef ? (
        <SecretInput refName={item.secretRef} store={store} />
      ) : null}
    </span>
  );
}

function SecretInput({ refName, store }: { refName: string; store: Store }) {
  const [v, setV] = useState("");
  return (
    <span class="secret">
      <input type="password" placeholder={`set ${refName}`} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="small" disabled={!v} onClick={() => { store.setSecret(refName, v); setV(""); }}>Store</button>
      <button class="small deny" onClick={() => store.deleteSecret(refName)}>Clear</button>
    </span>
  );
}

export function SettingsView({ store }: { store: Store }) {
  const cfg = store.state.config?.summary;
  const [active, setActive] = useState<"channels" | "agents" | "roles" | "settings">("channels");
  if (!cfg) {
    return (
      <div class="settings">
        <p class="hint">Loading config…</p>
        <button onClick={() => store.requestConfig()}>Reload</button>
      </div>
    );
  }
  const errors = store.state.config?.errors ?? [];
  const s = cfg.settings ?? ({} as SettingsSummary);
  return (
    <div class="settings">
      {errors.length ? (
        <div class="card errors">
          {errors.map((e, i) => <div key={i} class="fail">⚠ {e}</div>)}
        </div>
      ) : null}
      <nav class="tabs">
        {(["channels", "agents", "roles", "settings"] as const).map((t) => (
          <button key={t} class={active === t ? "tab active" : "tab"} onClick={() => setActive(t)}>{t}</button>
        ))}
      </nav>
      {active === "channels" ? (
        <ItemsSection<ChannelSummary>
          title="Channels" file="channels.yaml" items={cfg.channels ?? []} fields={CHANNEL_FIELDS} store={store}
          empty={{ id: "channel", type: "openai-compatible", enabled: true } as ChannelSummary}
          renderExtra={(i, st) => <ChannelExtra item={i} store={st} />}
        />
      ) : null}
      {active === "agents" ? (
        <ItemsSection<AgentSummary>
          title="Agents" file="agents.yaml" items={cfg.agents ?? []} fields={AGENT_FIELDS} store={store}
          empty={{ id: "agent", channel: cfg.channels?.[0]?.id ?? "", model: "", effort: "medium" } as AgentSummary}
        />
      ) : null}
      {active === "roles" ? (
        <ItemsSection<RoleSummary>
          title="Roles" file="roles.yaml" items={cfg.roles ?? []} fields={ROLE_FIELDS} store={store}
          empty={{ id: "role", enabled: false } as RoleSummary}
        />
      ) : null}
      {active === "settings" ? <SettingsEditor store={store} settings={s} /> : null}
    </div>
  );
}

function SettingsEditor({ store, settings }: { store: Store; settings: SettingsSummary }) {
  const { form, set } = useForm(settings as object);
  const save = () => {
    store.saveFile("settings.yaml", stringify({ version: 1, ...unflatten(form, SETTINGS_FIELDS) }, null, 2));
  };
  return (
    <section>
      <div class="form">
        {SETTINGS_FIELDS.map((f) => (
          <label key={f.key} class="field">
            <span>{f.label}</span>
            {f.kind === "select" ? (
              <select value={form[f.key] ?? ""} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>
                <option value="">—</option>
                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input value={form[f.key] ?? ""} onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)} />
            )}
          </label>
        ))}
      </div>
      <button class="send" onClick={save}>Save settings</button>
    </section>
  );
}
