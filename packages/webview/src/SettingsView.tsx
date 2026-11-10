import { useEffect, useState } from "preact/hooks";
import { Fragment } from "preact";
import type { ComponentChildren } from "preact";
import type { Store } from "./state.js";
import { SetupWizard } from "./SetupWizard.js";
import type { ChannelSummary, AgentSummary, RoleSummary, SkillSummary, SettingsSummary, ConfigReply } from "./bridge.js";
import type { Field } from "./fields.js";
import { looksLikeKey } from "./fields.js";
import { ItemsSection } from "./items.js";
import { ChannelExtra } from "./channelExtra.js";
import { AgentExtra } from "./agentExtra.js";
import { RolesSection } from "./rolesSection.js";
import { SkillsSection } from "./skillsSection.js";
import { SettingsEditor } from "./settingsEditor.js";

export { looksLikeKey };

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

export function modelsForChannel(
  channels: ChannelSummary[], tests: Record<string, { ok: boolean; models?: string[] }>, chId: string,
): string[] {
  const ch = channels.find((c) => c.id === chId);
  return [...new Set([...(tests[chId]?.ok ? tests[chId].models ?? [] : []), ...(ch?.extraModels ?? []), ...Object.keys(ch?.modelCaps ?? {})])];
}

function useAgentChannelTests(store: Store, active: SettingsTab, channels: ChannelSummary[] | undefined) {
  useEffect(() => {
    if (active !== "agents") return;
    for (const c of channels ?? []) if (c.enabled && !store.state.channelTest[c.id]) store.testChannel(c.id);
  }, [active, channels]);
}

function settingsData(cfg: NonNullable<ConfigReply["summary"]>): Pick<TabData, "channels" | "agents" | "roles" | "skills" | "settings"> {
  return {
    channels: cfg.channels ?? [],
    agents: cfg.agents ?? [],
    roles: cfg.roles ?? [],
    skills: cfg.skills ?? [],
    settings: cfg.settings ?? ({} as SettingsSummary),
  };
}

function SettingsErrors({ errors, lastError }: { errors: string[]; lastError?: string }) {
  if (!errors.length && !lastError) return null;
  return (
    <>
      {errors.length ? (
        <div class="card errors">
          {errors.map((e, i) => <div key={i} class="fail">⚠ {e}</div>)}
        </div>
      ) : null}
      {lastError ? (
        <div class="card errors">
          <div class="fail">⚠ {lastError}</div>
        </div>
      ) : null}
    </>
  );
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
  const data = settingsData(cfg);
  const showWizard = store.state.wizardOpen ?? (data.channels.length === 0 && data.agents.length === 0);
  return (
    <div class="settings">
      <SettingsErrors errors={store.state.config?.errors ?? []} lastError={store.state.lastError} />
      {showWizard ? <SetupWizard store={store} channels={data.channels} agents={data.agents} roles={data.roles} /> : null}
      <nav class="tabs">
        {SETTINGS_TABS.map((t) => (
          <button key={t} class={active === t ? "tab active" : "tab"} onClick={() => setActive(t)}>{t}</button>
        ))}
        <span class="spacer" />
        <button class="small" onClick={() => store.setWizardOpen(true)}>Run setup</button>
      </nav>
      <Fragment key={active}>{TAB_VIEWS[active]({ store, ...data })}</Fragment>
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
