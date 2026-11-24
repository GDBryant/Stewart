import { capBadges } from "./wizardShared.js";
import type { Effort } from "./bridge.js";
import type { DivertCandidate, FallbackMode, FallbackPreference } from "./wizardDeepThink.js";
import { EFFORTS } from "./wizardDeepThink.js";

export interface DeepThinkStepProps {
  candidates: DivertCandidate[];
  preference: FallbackPreference;
  onPreference(p: FallbackPreference): void;
  onBack(): void;
  onNext(): void;
}

function candidateLabel(c: DivertCandidate): string {
  const ctx = c.contextTokens ? ` · ${Math.round(c.contextTokens / 1000)}k ctx` : "";
  const cap = c.reasoning ? "" : " · capability unknown";
  return `${c.agentId} (${c.channel}:${c.model}${ctx}${cap})`;
}

function ModeRadios({ preference, onPreference }: Pick<DeepThinkStepProps, "preference" | "onPreference">) {
  const mode = (m: FallbackMode) => (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (m === "auto") onPreference({ mode: "auto" });
    else if (m === "off") onPreference({ mode: "off" });
    else onPreference({ mode: "explicit", agentId: preference.agentId ?? "auto", effort: preference.effort ?? "high" });
  };
  return (
    <div>
      <label class="field"><span><input type="radio" name="fallback" checked={preference.mode === "auto"} onChange={mode("auto")} /> Auto (best available)</span></label>
      <label class="field"><span><input type="radio" name="fallback" checked={preference.mode === "explicit"} onChange={mode("explicit")} /> A specific agent</span></label>
      <label class="field"><span><input type="radio" name="fallback" checked={preference.mode === "off"} onChange={mode("off")} /> Off</span></label>
    </div>
  );
}

function AgentSelect({ preference, candidates, onPreference }: Pick<DeepThinkStepProps, "preference" | "candidates" | "onPreference">) {
  return (
    <label class="field">
      <span>Hand-over agent</span>
      <select aria-label="hand-over agent" value={preference.mode === "explicit" ? (preference.agentId ?? "auto") : "auto"} onChange={(e) => onPreference({ mode: "explicit", agentId: (e.target as HTMLSelectElement).value, effort: preference.effort ?? "high" })}>
        <option value="auto">Auto (best available)</option>
        {candidates.map((c) => <option key={c.agentId} value={c.agentId}>{candidateLabel(c)}</option>)}
      </select>
    </label>
  );
}

function EffortSelect({ preference, onPreference }: Pick<DeepThinkStepProps, "preference" | "onPreference">) {
  return (
    <label class="field">
      <span>Effort for the hand-over agent</span>
      <select aria-label="hand-over effort" value={preference.mode === "explicit" ? (preference.effort ?? "high") : "high"} onChange={(e) => onPreference({ mode: "explicit", agentId: preference.agentId, effort: (e.target as HTMLSelectElement).value as Effort })}>
        {EFFORTS.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </label>
  );
}

export function DeepThinkStep({ candidates, preference, onPreference, onBack, onNext }: DeepThinkStepProps) {
  const explicit = preference.mode === "explicit" && preference.agentId && preference.agentId !== "auto";
  const chosen = candidates.find((c) => c.agentId === preference.agentId);
  return (
    <div class="form">
      <p><b>What to do:</b> decide what happens when a model gets stuck. If a run trips the loop guard (the same action over and over), Stewart can hand the task to a deeper-thinking model once.</p>
      <p>When the primary model gets stuck (loop guard), hand over to:</p>
      {candidates.length ? (
        <ModeRadios preference={preference} onPreference={onPreference} />
      ) : (
        <div class="hint">No probed models are eligible to take over, so the run stays on the static chain.</div>
      )}
      {candidates.length ? (
        <>
          <AgentSelect preference={preference} candidates={candidates} onPreference={onPreference} />
          {explicit ? (
            <EffortSelect preference={preference} onPreference={onPreference} />
          ) : null}
        </>
      ) : null}
      {chosen && chosen.reasoning === undefined ? <div class="hint">capability unknown: the channel does not report reasoning support</div> : null}
      {chosen ? <div class="hint">{capBadges(chosen.contextTokens ? { contextTokens: chosen.contextTokens } : undefined)}</div> : null}
      <p class="hint">Deep thinking uses more tokens; the cost cap still applies.</p>
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" onClick={onNext}>Next: review</button>
      </div>
    </div>
  );
}
