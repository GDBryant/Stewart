import { Spinner } from "./Busy.js";
import { key, type WizardPriorities } from "./wizardShared.js";

export interface EvaluatorStepProps {
  busy?: boolean;
  evalMode: "rules" | "ai";
  onEvalMode(mode: "rules" | "ai"): void;
  eligiblePairs: { channel: string; model: string }[];
  evaluator: string;
  evalSel: string;
  onEvaluator(v: string): void;
  priorities: WizardPriorities;
  onPriorities(p: WizardPriorities): void;
  typicalWork: string;
  onTypicalWork(v: string): void;
  onBuild(): void;
  onBack(): void;
}

type EvalModeChoiceProps = Pick<EvaluatorStepProps, "evalMode" | "onEvalMode" | "eligiblePairs" | "onEvaluator"> & { evaluatorValue: string };

function EvalModeChoice({ evalMode, onEvalMode, eligiblePairs, evaluatorValue, onEvaluator }: EvalModeChoiceProps) {
  return (
    <>
      <label class="field"><span><input type="radio" name="evalmode" checked={evalMode === "rules"} onChange={() => onEvalMode("rules")} /> Rules only (recommended)</span></label>
      <label class="field"><span><input type="radio" name="evalmode" checked={evalMode === "ai"} onChange={() => onEvalMode("ai")} /> AI refine</span></label>
      {evalMode === "ai" ? (
        <label class="field">
          <span>Evaluator model</span>
          <select aria-label="evaluator" value={evaluatorValue} onChange={(e) => onEvaluator((e.target as HTMLSelectElement).value)}>
            {eligiblePairs.map((p) => <option key={key(p.channel, p.model)} value={key(p.channel, p.model)}>{p.channel}:{p.model}</option>)}
          </select>
        </label>
      ) : null}
    </>
  );
}

function PrioritySliders({ priorities, onPriorities }: Pick<EvaluatorStepProps, "priorities" | "onPriorities">) {
  return (
    <>
      <div class="hint">What matters most? (1 = less, 3 = more)</div>
      {(["speed", "cost", "quality"] as const).map((k) => (
        <label key={k} class="field">
          <span>{k}: {priorities[k]}</span>
          <input
            type="range"
            min={1}
            max={3}
            aria-label={`priority ${k}`}
            value={priorities[k]}
            onInput={(e) => onPriorities({ ...priorities, [k]: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
      ))}
    </>
  );
}

function TypicalWorkSelect({ typicalWork, onTypicalWork }: Pick<EvaluatorStepProps, "typicalWork" | "onTypicalWork">) {
  return (
    <label class="field">
      <span>Typical work</span>
      <select aria-label="typical work" value={typicalWork} onChange={(e) => onTypicalWork((e.target as HTMLSelectElement).value)}>
        <option value="">(not sure)</option>
        <option value="scripts">small scripts and one-liners</option>
        <option value="features">features in one area</option>
        <option value="refactors">cross-cutting refactors</option>
        <option value="mixed">a mix</option>
      </select>
    </label>
  );
}

export function EvaluatorStep(props: EvaluatorStepProps) {
  const { eligiblePairs, evaluator, evalSel, onBuild, onBack, busy } = props;
  const evaluatorValue = evaluator || evalSel || (eligiblePairs[0] ? key(eligiblePairs[0].channel, eligiblePairs[0].model) : "");
  return (
    <div class="form">
      <p><b>What to do:</b> decide who matches models to roles. <b>Rules only</b> needs no model and always works. <b>AI refine</b> asks a model you pick to adjust the proposal (a bigger model gives better choices); its picks are still checked against each role's hard requirements.</p>
      <EvalModeChoice evalMode={props.evalMode} onEvalMode={props.onEvalMode} eligiblePairs={eligiblePairs} evaluatorValue={evaluatorValue} onEvaluator={props.onEvaluator} />
      <PrioritySliders priorities={props.priorities} onPriorities={props.onPriorities} />
      <TypicalWorkSelect typicalWork={props.typicalWork} onTypicalWork={props.onTypicalWork} />
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={busy} aria-busy={busy ? "true" : undefined} onClick={onBuild}>{busy ? <><Spinner /> Building…</> : "Build proposal"}</button>
      </div>
    </div>
  );
}
