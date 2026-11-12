import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary, SkillSummary } from "./bridge.js";
import { agentCosts } from "./bridge.js";
import { ChannelDot } from "./channelColors.js";

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

function RoleEditForm({ role, candidates, cap, allSkills, needsWrite, save, toggleSkill, isNew }: {
  role: RoleSummary;
  candidates: AgentSummary[];
  cap: "vision" | "imageGen" | undefined;
  allSkills: SkillSummary[];
  needsWrite: boolean;
  save(patch: Partial<RoleSummary>): void;
  toggleSkill(id: string): void;
  isNew?: boolean;
}) {
  return (
    <div class="form">
      {isNew ? (
        <label class="field">
          <span>id</span>
          <input value={role.id} onInput={(e) => save({ id: (e.target as HTMLInputElement).value })} />
        </label>
      ) : null}
      <RoleAgentField label="agent" value={role.agent} candidates={candidates} onPick={(v) => save({ agent: v })} />
      {cap && !candidates.length ? <p class="hint">No configured agent reports {cap}.</p> : null}
      <TurnBudgetField value={role.turnBudget} onSave={(v) => save({ turnBudget: v })} />
      <ToolPicker tools={role.tools} onSave={(v) => save({ tools: v })} />
      <CsvField label="chain (csv)" values={role.chain} onSave={(v) => save({ chain: v.length ? v : undefined })} />
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
  const agent = agents.find((a) => a.id === role.agent);
  return (
    <div class="card">
      <div class="card-title">
        <label class="field-inline">
          <input type="checkbox" checked={role.enabled} onChange={(e) => save({ enabled: (e.target as HTMLInputElement).checked })} />
          <b>{role.id}</b>
        </label>
        {agent ? <ChannelDot channel={agent.channel} title={`agent ${agent.id} runs on channel ${agent.channel}`} /> : null}
        <span class="summary">{(role.skills ?? []).join(", ")}</span>
        {agentCosts(agent, channels) ? <span class="badge warn" title="Assigned agent incurs cost">$ costs</span> : null}
        <span class="spacer" />
        <button class="small" onClick={onReset}>Reset</button>
        <button class="small" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      <div class="role-agent">{role.agent ? `agent: ${role.agent}` : "no agent"}</div>
      {open ? (
        <RoleEditForm role={role} candidates={candidates} cap={cap} allSkills={allSkills} needsWrite={needsWrite} save={save} toggleSkill={toggleSkill} />
      ) : null}
    </div>
  );
}

function NewRoleCard({ agents, channels, allSkills, existingIds, onSave, onCancel }: {
  agents: AgentSummary[];
  channels: ChannelSummary[];
  allSkills: SkillSummary[];
  existingIds: Set<string>;
  onSave(next: RoleSummary): void;
  onCancel(): void;
}) {
  const [role, setRole] = useState<RoleSummary>({ id: "", enabled: true, turnBudget: 25, skills: [], tools: [] });
  const save = (patch: Partial<RoleSummary>) => setRole((r) => ({ ...r, ...patch }));
  const toggleSkill = (id: string) => {
    const cur = role.skills ?? [];
    save({ skills: cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id] });
  };
  const id = role.id.trim();
  const dup = existingIds.has(id);
  const candidates = agentsForRole(role.id, agents, channels);
  const needsWrite = (role.tools ?? []).some((t) => SIDE_EFFECT_TOOLS.has(t));
  return (
    <div class="card">
      <div class="card-title">
        <b>new role</b>
        <span class="spacer" />
        {dup ? <span class="warn">id already exists</span> : null}
        <button class="deny" onClick={onCancel}>Cancel</button>
        <button class="send" disabled={!id || dup} onClick={() => onSave({ ...role, id })}>Save</button>
      </div>
      <RoleEditForm role={role} candidates={candidates} cap={ROLE_CAPABILITY[role.id]} allSkills={allSkills} needsWrite={needsWrite} save={save} toggleSkill={toggleSkill} isNew />
    </div>
  );
}

function RolesHeader({ store, agents, onAdd }: { store: Store; agents: AgentSummary[]; onAdd(): void }) {
  const [assignee, setAssignee] = useState("");
  return (
    <h3>
      Roles
      <span class="spacer" />
      <button class="small" onClick={onAdd}>+ Add</button>
      <select value={assignee} onChange={(e) => setAssignee((e.target as HTMLSelectElement).value)}>
        <option value="">assign agent…</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
      </select>
      <button class="small" disabled={!assignee} onClick={() => store.assignAgentToAll(assignee)}>Assign to all</button>
      <button class="small deny" onClick={() => store.resetRole()}>Reset all</button>
    </h3>
  );
}

export function RolesSection({ store, roles, agents, channels, skills }: {
  store: Store; roles: RoleSummary[]; agents: AgentSummary[]; channels: ChannelSummary[]; skills: SkillSummary[];
}) {
  const [draft, setDraft] = useState<RoleSummary | undefined>(undefined);
  const save = (next: RoleSummary[]) => store.saveFile("roles.yaml", stringify({ version: 1, items: next }, null, 2));
  const addDraft = () => setDraft({ id: "", enabled: true, turnBudget: 25, skills: [], tools: [] });
  return (
    <section>
      <RolesHeader store={store} agents={agents} onAdd={addDraft} />
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
      {draft ? (
        <NewRoleCard
          agents={agents}
          channels={channels}
          allSkills={skills}
          existingIds={new Set(roles.map((r) => r.id))}
          onSave={(next) => { save([...roles, next]); setDraft(undefined); }}
          onCancel={() => setDraft(undefined)}
        />
      ) : null}
      {!roles.length && !draft ? <p class="hint">No roles configured.</p> : null}
    </section>
  );
}
