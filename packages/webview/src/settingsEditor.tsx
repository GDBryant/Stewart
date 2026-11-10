import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { SettingsSummary } from "./bridge.js";
import { unflatten, useForm, type Field } from "./fields.js";

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
