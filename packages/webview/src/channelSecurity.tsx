import type { Store } from "./state.js";
import type { ChannelSummary, SettingsSummary } from "./bridge.js";
import { channelsYaml, CLI_HINT, effective, isCustom, RULES, withRule, type RuleKey } from "./security.js";

const CHOICE = { inherit: undefined, on: true, off: false } as const;
type Choice = keyof typeof CHOICE;

function choiceOf(c: ChannelSummary, rule: RuleKey): Choice {
  const v = c.security?.[rule];
  return v === undefined ? "inherit" : v ? "on" : "off";
}

/** Per-channel business-policy switches: Inherit / On / Off with the effective value and a reset. */
export function ChannelSecurity({ item, store }: { item: ChannelSummary; store: Store }) {
  const cfg = store.state.config?.summary;
  const channels = cfg?.channels ?? [];
  const global = (cfg?.settings ?? {}) as SettingsSummary;
  const save = (rule: RuleKey, value: boolean | undefined) => store.saveFile("channels.yaml", channelsYaml(withRule(channels, item.id, rule, value)));
  return (
    <div class="channel-security">
      <b>Security</b>
      {RULES.map((r) => (
        <label key={r.id} class="field" title={r.hint}>
          <span>{r.label}</span>
          <select value={choiceOf(item, r.id)} onChange={(e) => save(r.id, CHOICE[(e.target as HTMLSelectElement).value as Choice])}>
            <option value="inherit">Inherit</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          <span class="hint">{isCustom(item, r.id) ? "custom" : "inherited"}: {effective(global.security, item, r.id) ? "on" : "off"}</span>
          {isCustom(item, r.id) ? <button class="small" onClick={() => save(r.id, undefined)}>Reset to default</button> : null}
        </label>
      ))}
      {item.type === "claude-cli" ? <p class="hint">{CLI_HINT}</p> : null}
    </div>
  );
}
