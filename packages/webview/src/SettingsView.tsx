import { useEffect, useState } from "preact/hooks";
import { Fragment } from "preact";
import type { ComponentChildren, FunctionComponent } from "preact";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import { SetupWizard } from "./SetupWizard.js";
import type { ChannelSummary, AgentSummary, RoleSummary, SkillSummary, SettingsSummary, ConfigReply } from "./bridge.js";
import { agentCosts } from "./bridge.js";

type Field = {
  key: string;
  label: string;
  kind?: "text" | "bool" | "number" | "list" | "select" | "model" | "secret";
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

function coerceField(f: Field, raw: string): { has: boolean; value?: unknown } {
  if (f.kind === "bool") return { has: true, value: raw === "true" };
  if (f.kind === "number") return { has: true, value: Number(raw) };
  if (f.kind === "list") return { has: true, value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
  if (f.kind === "select" || f.kind === "model" || !f.kind) return { has: true, value: raw };
  return { has: false };
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

function FieldRow({ field, form, set, modelsFor }: FieldControlProps) {
  const Control = FIELD_CONTROLS[controlKind(field)];
  return (
    <label class="field">
      <span>{field.label}</span>
      <Control field={field} form={form} set={set} modelsFor={modelsFor} />
    </label>
  );
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
  return (
    <div class="card">
      <div class="card-title">
        <b>{form.id ?? (item as { id?: string }).id}</b> {extra ? extra(item) : null}
        <span class="spacer" />
        {onRemove ? <button class="deny" onClick={onRemove}>Remove</button> : null}
        <button onClick={() => { if (editing) set("apiKey", ""); setEditing(!editing); }}>{editing ? "Cancel" : "Edit"}</button>
        {editing ? (
          <button
            class="send"
            disabled={idMissing}
            onClick={() => {
              const merged = { ...(item as object), ...unflatten(form, fields) };
              const secrets: Record<string, string> = {};
              for (const f of fields) if (f.kind === "secret" && form[f.key]) secrets[f.key] = form[f.key];
              onSave(merged as T, secrets);
              set("apiKey", "");
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
            <FieldRow key={f.key} field={f} form={form} set={set} modelsFor={modelsFor} />
          ))}
        </div>
      ) : (
        <div class="summary">{fields.filter((f) => f.kind !== "secret" && form[f.key] !== undefined && form[f.key] !== "").map((f) => `${f.label}: ${form[f.key]}`).join(" · ")}</div>
      )}
    </div>
  );
}

function ItemsSection<T extends { id: string }>({
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

const CHANNEL_FIELDS: Field[] = [
  { key: "id", label: "id" },
  { key: "name", label: "name" },
  { key: "type", label: "type", kind: "select", options: ["openai-compatible", "ollama", "claude-cli"] },
  { key: "enabled", label: "enabled", kind: "bool" },
  { key: "baseUrl", label: "baseUrl", placeholder: "http://localhost:11434" },
  { key: "apiKey", label: "API key", kind: "secret", placeholder: "paste to store in IDE secrets (leave blank to keep)" },
  { key: "extraModels", label: "extraModels (csv)", kind: "list" },
  { key: "maxParallel", label: "maxParallel", kind: "number" },
];
const AGENT_FIELDS: Field[] = [
  { key: "id", label: "id" },
  { key: "channel", label: "channel", kind: "select" },
  { key: "model", label: "model", kind: "model" },
  { key: "effort", label: "effort", kind: "select", options: ["low", "medium", "high", "max"] },
  { key: "temperature", label: "temperature", kind: "number" },
  { key: "billing", label: "billing", kind: "select", options: ["free", "reported", "priced", "unmetered"] },
  { key: "price.inPerMTok", label: "in $/MTok", kind: "number" },
  { key: "price.outPerMTok", label: "out $/MTok", kind: "number" },
];
const SETTINGS_FIELDS: Field[] = [
  { key: "costLimit.perRunUsd", label: "cost limit $/run", kind: "number" },
  { key: "costLimit.onLimit", label: "on limit", kind: "select", options: ["ask", "stop"] },
  { key: "maxRunHours", label: "max run hours", kind: "number" },
  { key: "planGate", label: "plan gate", kind: "bool" },
  { key: "leaseWaitSeconds", label: "lease wait s", kind: "number" },
  { key: "maxNestedDispatches", label: "max nested dispatches", kind: "number" },
  { key: "maxReplans", label: "max replans", kind: "number" },
  { key: "skillBudgetTokens", label: "skill budget tokens", kind: "number" },
  { key: "log.level", label: "log level", kind: "select", options: ["off", "calls", "full"] },
  { key: "log.retainDays", label: "log retain days", kind: "number" },
];

export function modelsForChannel(
  channels: ChannelSummary[], tests: Record<string, { ok: boolean; models?: string[] }>, chId: string,
): string[] {
  const ch = channels.find((c) => c.id === chId);
  return [...new Set([...(tests[chId]?.ok ? tests[chId].models ?? [] : []), ...(ch?.extraModels ?? []), ...Object.keys(ch?.modelCaps ?? {})])];
}

/** A secretRef is a short name; a pasted API key is not. */
export function looksLikeKey(ref: string): boolean {
  return ref.length >= 32 || /^(sk|rk|pk|ghp|xox[a-z])[-_]/i.test(ref);
}

function ChannelExtra({ item, store }: { item: ChannelSummary; store: Store }) {
  const test = store.state.channelTest[item.id];
  const ref = item.secretRef;
  const stored = ref ? store.state.config?.secrets?.[ref] : undefined;
  const leaked = !!ref && looksLikeKey(ref);
  const moveToStore = () => {
    if (!ref) return;
    const newRef = `channel-${item.id}`;
    store.setSecret(newRef, ref);
    const items = (store.state.config?.summary.channels ?? []).map((c) => (c.id === item.id ? { ...c, secretRef: newRef } : c));
    store.saveFile("channels.yaml", stringify({ version: 1, items }, null, 2));
  };
  return (
    <span class="extra">
      {test ? (test.ok ? <span class="ok">✓ {(test.models ?? []).join(", ")}</span> : <span class="fail">✗ {test.error}</span>) : null}
      <button class="small" onClick={() => store.testChannel(item.id)}>Test</button>
      {leaked ? (
        <span class="fail">
          API key is saved as plain text in channels.yaml.{" "}
          <button class="small" onClick={moveToStore}>Move to secret store</button>
        </span>
      ) : ref ? (
        <span class="secret">
          {stored ? <span class="ok">key stored</span> : <span class="hint">no key stored</span>}
          {stored ? <button class="small deny" onClick={() => store.deleteSecret(ref)}>Clear key</button> : null}
        </span>
      ) : null}
    </span>
  );
}

function AgentBadges({ item, ch, channels, caps }: { item: AgentSummary; ch: ChannelSummary | undefined; channels: ChannelSummary[]; caps: Record<string, unknown> }) {
  const isUnmetered =
    item.billing === "unmetered" || (!item.billing && ch?.type === "openai-compatible" && ch.id !== "aif");
  return (
    <>
      {agentCosts(item, channels) ? <span class="badge warn" title="This agent incurs cost">$ costs</span> : null}
      {isUnmetered ? <span class="badge warn" title="Spend is not visible to cost limit">unmetered</span> : null}
      {typeof caps.tools === "string" ? <span class="badge">tools:{caps.tools}</span> : null}
      {caps.vision ? <span class="badge">vision</span> : null}
      {caps.reasoning ? <span class="badge">reasoning</span> : null}
      {caps.imageGen ? <span class="badge">imageGen</span> : null}
      {typeof caps.contextTokens === "number" ? <span class="badge">{Math.round(caps.contextTokens / 1000)}k</span> : null}
    </>
  );
}

function ProbeStatus({ probe, waiting }: { probe: { ok: boolean; error?: string; cached?: boolean; probedAt?: number } | undefined; waiting: boolean }) {
  if (waiting) return <span class="hint">probing…</span>;
  if (!probe) return null;
  return probe.ok
    ? <span class="ok" title={probe.probedAt ? new Date(probe.probedAt).toLocaleString() : undefined}>✓ probed{probe.cached ? " (cached)" : ""}</span>
    : <span class="fail">✗ {probe.error ?? "probe failed"}</span>;
}

function AgentExtra({ item, channels, store }: { item: AgentSummary; channels: ChannelSummary[]; store: Store }) {
  const ch = channels.find((c) => c.id === item.channel);
  const probe = store.state.probeResults[`${item.channel}:${item.model}`];
  const staticCaps = (ch?.modelCaps?.[item.model] ?? {}) as Record<string, unknown>;
  const caps = { ...staticCaps, ...(probe?.caps ?? {}) };
  const [pending, setPending] = useState<{ prev: unknown } | null>(null);
  const waiting = pending !== null && pending.prev === probe;
  return (
    <span class="extra">
      <AgentBadges item={item} ch={ch} channels={channels} caps={caps} />
      <ProbeStatus probe={probe} waiting={waiting} />
      <button class="small" disabled={waiting} onClick={() => { setPending({ prev: probe }); store.probeModel(item.channel, item.model, true); }}>
        {probe ? "Re-probe" : "Probe"}
      </button>
    </span>
  );
}


function useAgentChannelTests(store: Store, active: SettingsTab, channels: ChannelSummary[] | undefined) {
  useEffect(() => {
    if (active !== "agents") return;
    for (const c of channels ?? []) if (c.enabled && !store.state.channelTest[c.id]) store.testChannel(c.id);
  }, [active, channels]);
}

export function SettingsView({ store }: { store: Store }) {
  const cfg = store.state.config?.summary;
  const [active, setActive] = useState<SettingsTab>("channels");
  useAgentChannelTests(store, active, cfg?.channels);
  if (!cfg) {
    return (
      <div class="settings">
        <p class="hint">Loading config…</p>
        <button onClick={() => store.requestConfig()}>Reload</button>
      </div>
    );
  }
  const errors = store.state.config?.errors ?? [];
  const channels = cfg.channels ?? [];
  const agents = cfg.agents ?? [];
  const roles = cfg.roles ?? [];
  const skills = cfg.skills ?? [];
  const settings = cfg.settings ?? ({} as SettingsSummary);
  const tabData: TabData = { store, channels, agents, roles, skills, settings };
  const showWizard = store.state.wizardOpen ?? (channels.length === 0 && agents.length === 0);
  return (
    <div class="settings">
      {errors.length ? (
        <div class="card errors">
          {errors.map((e, i) => <div key={i} class="fail">⚠ {e}</div>)}
        </div>
      ) : null}
      {store.state.lastError ? (
        <div class="card errors">
          <div class="fail">⚠ {store.state.lastError}</div>
        </div>
      ) : null}
      {showWizard ? <SetupWizard store={store} channels={channels} agents={agents} roles={roles} /> : null}
      <nav class="tabs">
        {SETTINGS_TABS.map((t) => (
          <button key={t} class={active === t ? "tab active" : "tab"} onClick={() => setActive(t)}>{t}</button>
        ))}
        <span class="spacer" />
        <button class="small" onClick={() => store.setWizardOpen(true)}>Run setup</button>
      </nav>
      <Fragment key={active}>{TAB_VIEWS[active](tabData)}</Fragment>
    </div>
  );
}

const SIDE_EFFECT_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "RunTerminal"]);
const ROLE_CAPABILITY: Record<string, "vision" | "imageGen"> = { "image-reader": "vision", "image-writer": "imageGen" };

function agentsForRole(roleId: string, agents: AgentSummary[], channels: ChannelSummary[]): AgentSummary[] {
  const cap = ROLE_CAPABILITY[roleId];
  if (!cap) return agents;
  return agents.filter((a) => {
    const caps = channels.find((c) => c.id === a.channel)?.modelCaps?.[a.model] as Record<string, unknown> | undefined;
    return caps?.[cap] === true;
  });
}

function RoleAgentField({ label, value, candidates, onPick }: {
  label: string;
  value: string | undefined;
  candidates: AgentSummary[];
  onPick(next: string | undefined): void;
}) {
  return (
    <label class="field">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onPick((e.target as HTMLSelectElement).value || undefined)}>
        <option value="">—</option>
        {candidates.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
      </select>
    </label>
  );
}

function CsvField({ label, values, onSave }: { label: string; values: string[] | undefined; onSave(next: string[]): void }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input value={(values ?? []).join(", ")} onInput={(e) => onSave((e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean))} />
    </label>
  );
}

function ToolPicker({ tools, onSave }: { tools: string[] | undefined; onSave(next: string[]): void }) {
  return <CsvField label="tools (csv)" values={tools} onSave={onSave} />;
}

function TurnBudgetField({ value, onSave }: { value: RoleSummary["turnBudget"]; onSave(next: RoleSummary["turnBudget"]): void }) {
  return (
    <label class="field">
      <span>turnBudget</span>
      <input value={String(value ?? "")} onInput={(e) => {
        const v = (e.target as HTMLInputElement).value;
        onSave(v === "unlimited" ? "unlimited" : Number(v) || undefined);
      }} />
    </label>
  );
}

function SkillTicks({ skills, allSkills, needsWrite, onToggle }: {
  skills: string[] | undefined;
  allSkills: SkillSummary[];
  needsWrite: boolean;
  onToggle(id: string): void;
}) {
  return (
    <div class="field">
      <span>skills</span>
      <div class="skill-ticks">
        {allSkills.map((s) => (
          <label key={s.id} class="field-inline" title={s.description}>
            <input
              type="checkbox"
              checked={(skills ?? []).includes(s.id) || (s.id === "execution-contract" && needsWrite)}
              disabled={s.id === "execution-contract" && needsWrite}
              onChange={() => onToggle(s.id)}
            />
            {s.id}
            {s.updateAvailable ? <span class="warn">↑</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

function RoleEditForm({ role, candidates, cap, allSkills, needsWrite, save, toggleSkill }: {
  role: RoleSummary;
  candidates: AgentSummary[];
  cap: "vision" | "imageGen" | undefined;
  allSkills: SkillSummary[];
  needsWrite: boolean;
  save(patch: Partial<RoleSummary>): void;
  toggleSkill(id: string): void;
}) {
  return (
    <div class="form">
      <RoleAgentField label="agent" value={role.agent} candidates={candidates} onPick={(v) => save({ agent: v })} />
      <RoleAgentField label="fallback agent" value={role.fallbackAgent} candidates={candidates} onPick={(v) => save({ fallbackAgent: v })} />
      {cap && !candidates.length ? <p class="hint">No configured agent reports {cap}.</p> : null}
      <TurnBudgetField value={role.turnBudget} onSave={(v) => save({ turnBudget: v })} />
      <ToolPicker tools={role.tools} onSave={(v) => save({ tools: v })} />
      <CsvField label="writePaths (csv)" values={role.writePaths} onSave={(v) => save({ writePaths: v })} />
      <SkillTicks skills={role.skills} allSkills={allSkills} needsWrite={needsWrite} onToggle={toggleSkill} />
    </div>
  );
}

function RoleCard({ role, agents, channels, allSkills, onSave, onReset }: {
  role: RoleSummary;
  agents: AgentSummary[];
  channels: ChannelSummary[];
  allSkills: SkillSummary[];
  onSave(next: RoleSummary): void;
  onReset(): void;
}) {
  const [open, setOpen] = useState(false);
  const save = (patch: Partial<RoleSummary>) => onSave({ ...role, ...patch });
  const toggleSkill = (id: string) => {
    const cur = role.skills ?? [];
    save({ skills: cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id] });
  };
  const candidates = agentsForRole(role.id, agents, channels);
  const cap = ROLE_CAPABILITY[role.id];
  const needsWrite = (role.tools ?? []).some((t) => SIDE_EFFECT_TOOLS.has(t));
  return (
    <div class="card">
      <div class="card-title">
        <label class="field-inline">
          <input type="checkbox" checked={role.enabled} onChange={(e) => save({ enabled: (e.target as HTMLInputElement).checked })} />
          <b>{role.id}</b>
        </label>
        <span class="summary">{(role.skills ?? []).join(", ")}</span>
        {agentCosts(agents.find((a) => a.id === role.agent), channels) ? <span class="badge warn" title="Assigned agent incurs cost">$ costs</span> : null}
        <span class="spacer" />
        <button class="small" onClick={onReset}>Reset</button>
        <button class="small" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      {open ? (
        <RoleEditForm role={role} candidates={candidates} cap={cap} allSkills={allSkills} needsWrite={needsWrite} save={save} toggleSkill={toggleSkill} />
      ) : null}
    </div>
  );
}

function RolesSection({ store, roles, agents, channels, skills }: {
  store: Store; roles: RoleSummary[]; agents: AgentSummary[]; channels: ChannelSummary[]; skills: SkillSummary[];
}) {
  const [assignee, setAssignee] = useState("");
  const save = (next: RoleSummary[]) => store.saveFile("roles.yaml", stringify({ version: 1, items: next }, null, 2));
  return (
    <section>
      <h3>
        Roles
        <span class="spacer" />
        <select value={assignee} onChange={(e) => setAssignee((e.target as HTMLSelectElement).value)}>
          <option value="">assign agent…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
        </select>
        <button class="small" disabled={!assignee} onClick={() => store.assignAgentToAll(assignee)}>Assign to all</button>
        <button class="small deny" onClick={() => store.resetRole()}>Reset all</button>
      </h3>
      {roles.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          agents={agents}
          channels={channels}
          allSkills={skills}
          onSave={(next) => save(roles.map((x) => (x.id === r.id ? next : x)))}
          onReset={() => store.resetRole(r.id)}
        />
      ))}
      {!roles.length ? <p class="hint">No roles configured.</p> : null}
    </section>
  );
}

function SkillCard({ skill, store }: { skill: SkillSummary; store: Store }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(skill.body);
  return (
    <div class="card">
      <div class="card-title">
        <b>{skill.id}</b>
        <span class={`badge src-${skill.source}`}>{skill.source}</span>
        {skill.edited ? <span class="badge">edited</span> : null}
        {skill.updateAvailable ? <span class="badge warn" title="Shipped version changed since your edit">update available</span> : null}
        <span class="summary">{skill.description}</span>
        <span class="spacer" />
        {skill.source !== "shipped" ? <button class="small deny" onClick={() => store.resetSkill(skill.id)}>Reset</button> : null}
        <button class="small" onClick={() => store.openSkill(skill.id)}>Open file</button>
        <button class="small" onClick={() => { setBody(skill.body); setEditing(!editing); }}>{editing ? "Cancel" : "Edit"}</button>
      </div>
      {editing ? (
        <div class="form">
          <textarea rows={8} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          <button class="send" onClick={() => { store.saveSkill(skill.id, body, skill.description); setEditing(false); }}>Save</button>
        </div>
      ) : null}
    </div>
  );
}

function NewSkill({ store, existing }: { store: Store; existing: string[] }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const clean = id.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  const clash = existing.includes(clean);
  return (
    <div class="card">
      <div class="card-title">
        <b>New skill</b>
        <span class="spacer" />
        <button class="small" onClick={() => setOpen(!open)}>{open ? "Cancel" : "+ New"}</button>
      </div>
      {open ? (
        <div class="form">
          <label class="field">
            <span>id</span>
            <input value={id} placeholder="my-skill" onInput={(e) => setId((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>description</span>
            <input value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>body</span>
            <textarea rows={8} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          </label>
          {clash ? <p class="fail">skill '{clean}' already exists</p> : null}
          <button
            class="send"
            disabled={!clean || clash}
            onClick={() => {
              store.saveSkill(clean, body, description);
              setOpen(false);
              setId("");
              setDescription("");
              setBody("");
            }}
          >
            Create
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SkillsSection({ store, skills }: { store: Store; skills: SkillSummary[] }) {
  return (
    <section>
      <h3>Skills</h3>
      <NewSkill store={store} existing={skills.map((s) => s.id)} />
      {skills.map((s) => <SkillCard key={s.id} skill={s} store={store} />)}
      {!skills.length ? <p class="hint">No skills found.</p> : null}
    </section>
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
      <V1ImportCard store={store} />
    </section>
  );
}

function V1ImportCard({ store }: { store: Store }) {
  const draft = store.state.v1Draft;
  return (
    <div class="card v1import">
      <div class="card-title">
        <b>Import v1 settings</b>
        <span class="spacer" />
        <button class="small" onClick={() => store.requestV1Import()}>Pick stewart.xml…</button>
      </div>
      <p class="hint">One-shot import of channels, models and settings from the v1 plugin's stewart.xml.</p>
      {draft ? (
        <div class="form">
          {draft.warnings.map((w, i) => (
            <div key={i} class="warn">⚠ {w}</div>
          ))}
          <div class="summary">{Object.keys(draft.files).length ? `produces: ${Object.keys(draft.files).join(", ")}` : "nothing to import"}</div>
          <div class="row">
            <button class="send" disabled={!Object.keys(draft.files).length} onClick={() => store.applyV1Draft()}>Apply</button>
            <button class="small deny" onClick={() => store.dismissV1Draft()}>Dismiss</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SettingsTab = "channels" | "agents" | "roles" | "skills" | "settings" | "integrations";
const SETTINGS_TABS: SettingsTab[] = ["channels", "agents", "roles", "skills", "settings", "integrations"];

interface TabData {
  store: Store;
  channels: ChannelSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  skills: SkillSummary[];
  settings: SettingsSummary;
}

const TAB_VIEWS: Record<SettingsTab, (d: TabData) => ComponentChildren> = {
  channels: ({ store, channels }) => (
    <ItemsSection<ChannelSummary>
      title="Channels" file="channels.yaml" items={channels} fields={CHANNEL_FIELDS} store={store}
      empty={{ id: "channel", type: "openai-compatible", enabled: true } as ChannelSummary}
      renderExtra={(i, st) => <ChannelExtra item={i} store={st} />}
    />
  ),
  agents: ({ store, channels, agents }) => (
    <ItemsSection<AgentSummary>
      title="Agents" file="agents.yaml" items={agents} store={store}
      fields={AGENT_FIELDS.map((f) => (f.key === "channel" ? { ...f, options: channels.map((c) => c.id) } : f))}
      modelsFor={(chId) => modelsForChannel(channels, store.state.channelTest, chId)}
      empty={{ id: "agent", channel: channels[0]?.id ?? "", model: "", effort: "medium" } as AgentSummary}
      renderExtra={(i, st) => <AgentExtra item={i} channels={channels} store={st} />}
    />
  ),
  roles: ({ store, roles, agents, channels, skills }) => (
    <RolesSection store={store} roles={roles} agents={agents} channels={channels} skills={skills} />
  ),
  skills: ({ store, skills }) => <SkillsSection store={store} skills={skills} />,
  settings: ({ store, settings }) => <SettingsEditor store={store} settings={settings} />,
  integrations: () => (
    <section>
      <h3>Integrations</h3>
      <p class="hint">Task tracker (Jira) and IDE Git workflow connectors will be configured here in a future milestone.</p>
    </section>
  ),
};
