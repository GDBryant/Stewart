import { useState } from "preact/hooks";
import type { State } from "./state.js";
import type { CatalogInfo, RoleSummary } from "./bridge.js";
import { key } from "./wizardShared.js";
import { ChannelDot } from "./channelColors.js";
import { BusyNote, Spinner } from "./Busy.js";

type Assignment = NonNullable<State["recommendation"]>["assignments"][number];

function ReviewRoleRow({
  role, assignment, unfilled, chosen, edit, catalog, options, onChange,
}: {
  role: RoleSummary;
  assignment?: Assignment;
  unfilled?: { role: string; reason: string };
  chosen: string;
  edit?: string;
  catalog?: CatalogInfo;
  options: { channel: string; model: string }[];
  onChange(ref: string): void;
}) {
  const ci = chosen.indexOf(":");
  const chId = ci > 0 ? chosen.slice(0, ci) : "";
  return (
    <div class="summary" title={assignment?.reason}>
      {chId ? <ChannelDot channel={chId} title={`channel ${chId}`} /> : null}
      <b>{role.id}</b>{" "}
      <select aria-label={`role ${role.id}`} value={chosen} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">(disabled)</option>
        {options.map((p) => <option key={key(p.channel, p.model)} value={key(p.channel, p.model)}>{p.channel}:{p.model}</option>)}
      </select>
      {assignment?.reason ? <span class="hint"> — {assignment.reason}</span> : null}
      {catalog ? (
        <span class="hint">
          {" "}· {catalog.inPerMTok !== undefined ? `$${catalog.inPerMTok.toFixed(2)}/MTok in, ` : ""}{catalog.source}
        </span>
      ) : null}
      {unfilled && !edit ? <span class="hint"> — disabled: {unfilled.reason}</span> : null}
      {assignment?.warnings?.map((w) => <div key={w} class="fail">⚠ {w}</div>)}
    </div>
  );
}

export function ReviewStep({
  rec, recommendBusy, recommendError, evalMode, bench, roles, eligiblePairs, rowFor, edits, probeResults, onEditRole, onApply, onBack, onUseRules,
}: {
  rec: State["recommendation"];
  recommendBusy: State["recommendBusy"];
  recommendError: State["recommendError"];
  evalMode: "rules" | "ai";
  bench: boolean;
  roles: RoleSummary[];
  eligiblePairs: { channel: string; model: string }[];
  rowFor(roleId: string): string;
  edits: Record<string, string>;
  probeResults: State["probeResults"];
  onEditRole(roleId: string, ref: string): void;
  onApply(): void;
  onBack(): void;
  onUseRules(): void;
}) {
  return (
    <div class="form">
      <p><b>What to do:</b> check who does what. Change any row, or leave a role off. Warnings mean the model is weak for that role.</p>
      {recommendBusy ? (
        <BusyNote
          label={
            bench
              ? "Measuring model speed and building the proposal — this can take several minutes…"
              : evalMode === "ai"
                ? "AI evaluator is refining the proposal — this can take a few minutes…"
                : "Matching models to roles…"
          }
        />
      ) : null}
      {recommendError ? (
        <div class="fail">
          {recommendError}
          {evalMode === "ai" ? <button class="small" onClick={onUseRules}>Use rules instead</button> : null}
        </div>
      ) : null}
      {rec ? (
        <div>
          {rec.researcher ? <div class="hint">Refined by {rec.researcher.channel}:{rec.researcher.model}</div> : null}
          {roles.map((r) => {
            const a = rec.assignments.find((x) => x.role === r.id);
            const un = rec.unfilled?.find((x) => x.role === r.id);
            const chosen = rowFor(r.id);
            const catalog = chosen ? probeResults[chosen]?.catalog : undefined;
            return (
              <ReviewRoleRow
                key={r.id}
                role={r}
                assignment={a}
                unfilled={un}
                chosen={chosen}
                edit={edits[r.id]}
                catalog={catalog}
                options={eligiblePairs}
                onChange={(ref) => onEditRole(r.id, ref)}
              />
            );
          })}
          {rec.dropped?.length ? <div class="hint">Ignored AI picks: {rec.dropped.join("; ")}</div> : null}
        </div>
      ) : null}
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={!rec || recommendBusy} aria-busy={recommendBusy ? "true" : undefined} onClick={onApply}>
          {recommendBusy ? <><Spinner /> Apply</> : "Apply"}
        </button>
      </div>
    </div>
  );
}

export function DoneStep({ setupSaved, setupError, onUndo, onFinish }: {
  setupSaved: State["setupSaved"];
  setupError: State["setupError"];
  onUndo(): void;
  onFinish(): void;
}) {
  const [undoing, setUndoing] = useState(false);
  const saving = setupSaved === undefined && !setupError;
  const failed = setupSaved === false || !!setupError;
  return (
    <div class="form">
      {saving ? (
        <BusyNote label="Saving configuration…" />
      ) : failed ? (
        <p><b>Save failed.</b> {setupError ?? "unknown error"} — nothing was written.</p>
      ) : (
        <p><b>Setup complete.</b> Roles now use the agents you approved. Go to Chat and try: <i>“Summarise this project’s structure.”</i></p>
      )}
      <p class="hint">Re-run any time from Settings → Run setup. Fine-tune channels, agents and roles in their tabs.</p>
      <div class="row">
        {setupSaved ? (
          <button
            class="small"
            disabled={undoing}
            aria-busy={undoing ? "true" : undefined}
            onClick={() => {
              if (undoing) return;
              setUndoing(true);
              onUndo();
            }}
          >
            {undoing ? <><Spinner /> Undoing…</> : "Undo"}
          </button>
        ) : null}
        <button class="send" onClick={onFinish}>Finish</button>
      </div>
    </div>
  );
}
