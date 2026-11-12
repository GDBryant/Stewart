import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { SettingsSummary } from "./bridge.js";
import { unflatten, useForm, type Field } from "./fields.js";

const SETTINGS_FIELDS: Field[] = [
  { key: "costLimit.perRunUsd", label: "cost limit $/run", kind: "number" },
  { key: "costLimit.onLimit", label: "on limit", kind: "select", options: ["ask", "stop"] },
  { key: "skillBudgetTokens", label: "skill budget tokens", kind: "number" },
  { key: "log.level", label: "log level", kind: "select", options: ["off", "calls", "full"] },
  { key: "log.retainDays", label: "log retain days", kind: "number" },
];

export function SettingsEditor({ store, settings }: { store: Store; settings: SettingsSummary }) {
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
