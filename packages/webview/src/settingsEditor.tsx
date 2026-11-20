import { Fragment } from "preact";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { SettingsSummary } from "./bridge.js";
import { unflatten, useForm, type Field } from "./fields.js";

const GROUPS: { title: string; hint?: string; fields: Field[] }[] = [
  {
    title: "Run limits",
    hint: "The turn limit applies to the lead agent; 1000+ lets a run continue until it finishes.",
    fields: [
      { key: "costLimit.perRunUsd", label: "cost limit ($ per run)", kind: "number" },
      { key: "costLimit.onLimit", label: "when limit is hit", kind: "select", options: ["ask", "stop"] },
      { key: "runTurnLimit", label: "run turn limit", kind: "number" },
      { key: "skillBudgetTokens", label: "skill budget tokens", kind: "number" },
    ],
  },
  {
    title: "Logging",
    fields: [
      { key: "log.level", label: "log level", kind: "select", options: ["off", "calls", "full"] },
      { key: "log.retainDays", label: "retain logs (days)", kind: "number" },
    ],
  },
];
const SETTINGS_FIELDS: Field[] = GROUPS.flatMap((g) => g.fields);

/** Settings the tab does not edit (setupPriorities, historyRetentionDays, ...) are written back unchanged. */
function settingsYaml(settings: SettingsSummary, form: Record<string, string>): string {
  const shown = new Set(SETTINGS_FIELDS.map((f) => f.key.split(".")[0]));
  const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !shown.has(k)));
  return stringify({ version: 1, ...kept, ...unflatten(form, SETTINGS_FIELDS) }, null, 2);
}

function FieldInput({ f, form, set }: { f: Field; form: Record<string, string>; set(k: string, v: string): void }) {
  return (
    <label class="field">
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
  );
}

export function SettingsEditor({ store, settings }: { store: Store; settings: SettingsSummary }) {
  const { form, set } = useForm(settings as object);
  const save = () => store.saveFile("settings.yaml", settingsYaml(settings, form));
  return (
    <section>
      {GROUPS.map((g) => (
        <Fragment key={g.title}>
          <h3>{g.title}</h3>
          <div class="form">
            {g.fields.map((f) => <FieldInput key={f.key} f={f} form={form} set={set} />)}
          </div>
          {g.hint ? <p class="hint">{g.hint}</p> : null}
        </Fragment>
      ))}
      <button class="send" onClick={save}>Save settings</button>
    </section>
  );
}
