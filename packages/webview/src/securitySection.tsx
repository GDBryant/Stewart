import { useState } from "preact/hooks";
import type { Store } from "./state.js";
import type { ChannelSummary, SettingsSummary } from "./bridge.js";
import { channelsYaml, customCount, effective, GLOBAL_HINT, RULES, settingsWith, withoutOverrides } from "./security.js";

function ApplyAll({ store, channels }: { store: Store; channels: ChannelSummary[] }) {
  const [asking, setAsking] = useState(false);
  const n = customCount(channels);
  const apply = () => {
    store.saveFile("channels.yaml", channelsYaml(withoutOverrides(channels)));
    setAsking(false);
  };
  if (!asking) return <button onClick={() => (n ? setAsking(true) : apply())}>Apply to all channels</button>;
  return (
    <span class="confirm">
      <span class="hint">{n} channel{n === 1 ? " has" : "s have"} custom settings; they will be reset to these defaults.</span>
      <button class="deny" onClick={apply}>Reset them</button>
      <button onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

/** Settings → settings → Security: global business-policy defaults; channels inherit unless overridden. */
export function SecuritySection({ store, settings, channels }: { store: Store; settings: SettingsSummary; channels: ChannelSummary[] }) {
  return (
    <section class="security">
      <h3>Security</h3>
      <p class="hint">Business policy checks what leaves this machine. These are the defaults for every channel; a channel can override them in its own settings.</p>
      {RULES.map((r) => (
        <label key={r.id} class="sec-row" title={r.hint}>
          <input type="checkbox" checked={effective(settings.security, undefined, r.id)} onChange={(e) => store.saveFile("settings.yaml", settingsWith(settings, r.id, (e.target as HTMLInputElement).checked))} />
          <span class="sec-name">{r.label}</span>
          <span class="hint">{r.hint}</span>
        </label>
      ))}
      <p class="hint">{GLOBAL_HINT}</p>
      <ApplyAll store={store} channels={channels} />
    </section>
  );
}
