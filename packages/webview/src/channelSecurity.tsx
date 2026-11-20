import type { Store } from "./state.js";
import type { ChannelSummary, SettingsSummary } from "./bridge.js";
import { channelsYaml, CLI_HINT, isCustom, RULES, withRule, type RuleKey } from "./security.js";

const CHOICE = { inherit: undefined, on: true, off: false } as const;
type Choice = keyof typeof CHOICE;

function choiceOf(c: ChannelSummary, rule: RuleKey): Choice {
  const v = c.security?.[rule];
  return v === undefined ? "inherit" : v ? "on" : "off";
}

/** Per-channel business-policy switches: Inherit (global default shown) / On / Off, with an inline reset. */
export function ChannelSecurity({ item, store }: { item: ChannelSummary; store: Store }) {
  const cfg = store.state.config?.summary;
  const channels = cfg?.channels ?? [];
  const global = (cfg?.settings ?? {}) as SettingsSummary;
  const save = (rule: RuleKey, value: boolean | undefined) => store.saveFile("channels.yaml", channelsYaml(withRule(channels, item.id, rule, value)));
  return (
    <div class="channel-security">
      <span class="sec-label">Security</span>
      {RULES.map((r) => (
        <label key={r.id} class="sec-rule" title={r.hint}>
          <span>{r.label}</span>
          <select value={choiceOf(item, r.id)} onChange={(e) => save(r.id, CHOICE[(e.target as HTMLSelectElement).value as Choice])}>
            <option value="inherit">Inherit ({(global.security?.[r.id] ?? true) ? "on" : "off"})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          {isCustom(item, r.id) ? (
            <button class="small" title="Reset to inherited default" onClick={() => save(r.id, undefined)}>Reset</button>
          ) : null}
        </label>
      ))}
      {item.type === "claude-cli" ? <span class="hint">{CLI_HINT}</span> : null}
    </div>
  );
}
