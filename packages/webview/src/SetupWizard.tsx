import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "./bridge.js";
import { PRESETS, STEPS, friendlyError, recommendArgs, rowRef } from "./wizardShared.js";
import { useWizardChannelForm, useWizardDerived, useWizardPreferences, useWizardProbes } from "./wizardDerived.js";
import { buildAgentsForRoles } from "./wizardApply.js";
import { WelcomeStep, ChannelsStep, DiscoverStep, EvaluatorStep } from "./SetupWizardSteps.js";
import { ReviewStep, DoneStep } from "./SetupWizardResult.js";

export { PRESETS, STEPS, friendlyError };

export function SetupWizard({ store, channels, agents, roles }: { store: Store; channels: ChannelSummary[]; agents: AgentSummary[]; roles: RoleSummary[] }) {
  const [step, setStep] = useState(0);
  const [evalMode, setEvalMode] = useState<"rules" | "ai">("rules");
  const [evaluator, setEvaluator] = useState("");
  const [bench, setBench] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [source, setSource] = useState<"existing" | "new">(channels.length > 0 ? "existing" : "new");
  const [evalChannel, setEvalChannel] = useState("");

  const { preset, chId, setChId, baseUrl, setBaseUrl, apiKey, setApiKey, added, pickPreset, addChannel } = useWizardChannelForm({ store, channels });
  const { priorities, setPriorities, typicalWork, setTypicalWork } = useWizardPreferences(store);

  const {
    tests, enabled, okChannels, pairs, smoke, eligiblePairs, probeBusy, retryable,
    evalChannels, evalChan, evalChanObj, evalAgents, evalOptions, evalSel, probeSig,
  } = useWizardDerived({ store, channels, agents, source, added, evalChannel, evaluator });

  useWizardProbes({ store, step, enabled, tests, probeSig, pairs, evalSel });

  const rec = store.state.recommendation;
  const row = (role: string) => rowRef(rec, edits, role);
  const buildProposal = () => {
    setEdits({});
    store.recommend(recommendArgs({ evalMode, evaluator, evalSel, eligiblePairs, priorities, typicalWork, bench }));
    setStep(4);
  };

  const apply = () => {
    if (!rec) return;
    const chosen = roles.map((r) => ({ role: r.id, ref: row(r.id) }));
    const { agents: nextAgents, roles: nextRoles } = buildAgentsForRoles({ agents, channels, roles, chosen, probeResults: store.state.probeResults });
    store.setupApply({
      "agents.yaml": stringify({ version: 1, items: nextAgents }, null, 2),
      "roles.yaml": stringify({ version: 1, items: nextRoles }, null, 2),
    });
    store.dismissRecommendation();
    setStep(5);
  };

  const statusChannels = source === "existing" ? enabled : enabled.filter((c) => added.has(c.id));

  return (
    <div class="card wizard">
      <div class="card-title">
        <b>First-run setup wizard</b>
        <span class="spacer" />
        <span class="hint">Step {step + 1} of {STEPS.length}: {STEPS[step]}</span>
        <button class="small" onClick={() => store.setWizardOpen(false)}>Close</button>
      </div>
      <progress max={STEPS.length - 1} value={step} aria-label="setup progress" />

      {step === 0 ? <WelcomeStep onStart={() => setStep(1)} /> : null}
      {step === 1 ? (
        <ChannelsStep
          store={store}
          hasChannels={channels.length > 0}
          source={source}
          onSource={setSource}
          preset={preset}
          chId={chId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          onPickPreset={pickPreset}
          onChId={setChId}
          onBaseUrl={setBaseUrl}
          onApiKey={setApiKey}
          onAddChannel={addChannel}
          statusChannels={statusChannels}
          tests={tests}
          evalChannels={evalChannels}
          evalChan={evalChan}
          evalChanObj={evalChanObj}
          evalAgents={evalAgents}
          evalOptions={evalOptions}
          evalSel={evalSel}
          onEvalChannel={(v) => {
            setEvalChannel(v);
            setEvaluator("");
          }}
          onEvaluator={setEvaluator}
          nextDisabled={okChannels.length === 0 || !evalSel}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      ) : null}
      {step === 2 ? (
        <DiscoverStep
          smoke={smoke}
          pairs={pairs}
          probeBusy={probeBusy}
          retryable={retryable}
          bench={bench}
          probeResults={store.state.probeResults}
          onBench={setBench}
          onAccept={() => {
            store.cancelProbe();
            setStep(3);
          }}
          onRetry={() => store.retryProbe()}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ) : null}
      {step === 3 ? (
        <EvaluatorStep
          evalMode={evalMode}
          onEvalMode={setEvalMode}
          eligiblePairs={eligiblePairs}
          evaluator={evaluator}
          evalSel={evalSel}
          onEvaluator={setEvaluator}
          priorities={priorities}
          onPriorities={setPriorities}
          typicalWork={typicalWork}
          onTypicalWork={setTypicalWork}
          onBuild={buildProposal}
          onBack={() => setStep(2)}
        />
      ) : null}
      {step === 4 ? (
        <ReviewStep
          rec={rec}
          recommendBusy={store.state.recommendBusy}
          recommendError={store.state.recommendError}
          evalMode={evalMode}
          roles={roles}
          eligiblePairs={eligiblePairs}
          rowFor={row}
          edits={edits}
          probeResults={store.state.probeResults}
          onEditRole={(roleId, ref) => setEdits({ ...edits, [roleId]: ref })}
          onApply={apply}
          onBack={() => setStep(3)}
          onUseRules={() => {
            setEvalMode("rules");
            store.recommend({ mode: "rules" });
          }}
        />
      ) : null}
      {step === 5 ? (
        <DoneStep
          setupSaved={store.state.setupSaved}
          setupError={store.state.setupError}
          onUndo={() => store.setupUndo()}
          onFinish={() => store.setWizardOpen(false)}
        />
      ) : null}
    </div>
  );
}
