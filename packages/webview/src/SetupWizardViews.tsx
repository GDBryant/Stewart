import type { SetupWizardModel } from "./SetupWizardModel.js";
import { WelcomeStep, ChannelsStep, DiscoverStep, EvaluatorStep } from "./SetupWizardSteps.js";
import { ReviewStep, DoneStep } from "./SetupWizardResult.js";

function ChannelsStepView({ m }: { m: SetupWizardModel }) {
  return (
    <ChannelsStep
      store={m.store}
      hasChannels={m.channels.length > 0}
      source={m.source}
      onSource={m.setSource}
      preset={m.preset}
      chId={m.chId}
      baseUrl={m.baseUrl}
      apiKey={m.apiKey}
      onPickPreset={m.pickPreset}
      onChId={m.setChId}
      onBaseUrl={m.setBaseUrl}
      onApiKey={m.setApiKey}
      onAddChannel={m.addChannel}
      addError={m.store.state.setupChannelError}
      statusChannels={m.statusChannels}
      tests={m.tests}
      evalChannels={m.evalChannels}
      evalChan={m.evalChan}
      evalChanObj={m.evalChanObj}
      evalAgents={m.evalAgents}
      evalOptions={m.evalOptions}
      evalSel={m.evalSel}
      onEvalChannel={(v) => {
        m.setEvalChannel(v);
        m.setEvaluator("");
      }}
      onEvaluator={m.setEvaluator}
      nextDisabled={m.okChannels.length === 0 || !m.evalSel}
      onBack={() => m.setStep(0)}
      onNext={() => m.setStep(2)}
    />
  );
}

function DiscoverStepView({ m }: { m: SetupWizardModel }) {
  return (
    <DiscoverStep
      smoke={m.smoke}
      pairs={m.pairs}
      probeBusy={m.probeBusy}
      retryable={m.retryable}
      bench={m.bench}
      probeResults={m.store.state.probeResults}
      onBench={m.setBench}
      onAccept={() => {
        m.store.cancelProbe();
        m.setStep(3);
      }}
      onRetry={() => m.store.retryProbe()}
      onBack={() => m.setStep(1)}
      onNext={() => m.setStep(3)}
    />
  );
}

function EvaluatorStepView({ m }: { m: SetupWizardModel }) {
  return (
    <EvaluatorStep
      evalMode={m.evalMode}
      onEvalMode={m.setEvalMode}
      eligiblePairs={m.eligiblePairs}
      evaluator={m.evaluator}
      evalSel={m.evalSel}
      onEvaluator={m.setEvaluator}
      priorities={m.priorities}
      onPriorities={m.setPriorities}
      typicalWork={m.typicalWork}
      onTypicalWork={m.setTypicalWork}
      onBuild={m.buildProposal}
      busy={m.store.state.recommendBusy}
      onBack={() => m.setStep(2)}
    />
  );
}

function ReviewStepView({ m }: { m: SetupWizardModel }) {
  return (
    <ReviewStep
      rec={m.rec}
      recommendBusy={m.store.state.recommendBusy}
      recommendError={m.store.state.recommendError}
      evalMode={m.evalMode}
      bench={m.bench}
      roles={m.roles}
      eligiblePairs={m.eligiblePairs}
      rowFor={m.row}
      edits={m.edits}
      probeResults={m.store.state.probeResults}
      onEditRole={(roleId, ref) => m.setEdits({ ...m.edits, [roleId]: ref })}
      onApply={m.apply}
      onBack={() => m.setStep(3)}
      onUseRules={() => {
        m.setEvalMode("rules");
        m.store.recommend({ mode: "rules" });
      }}
    />
  );
}

function DoneStepView({ m }: { m: SetupWizardModel }) {
  return (
    <DoneStep
      setupSaved={m.store.state.setupSaved}
      setupError={m.store.state.setupError}
      onUndo={() => m.store.setupUndo()}
      onFinish={() => m.store.setWizardOpen(false)}
    />
  );
}

/** Renders the current step. Each step is its own component so the switch stays small. */
export function StepSwitch({ m }: { m: SetupWizardModel }) {
  return (
    <>
      {m.step === 0 ? <WelcomeStep onStart={() => m.setStep(1)} /> : null}
      {m.step === 1 ? <ChannelsStepView m={m} /> : null}
      {m.step === 2 ? <DiscoverStepView m={m} /> : null}
      {m.step === 3 ? <EvaluatorStepView m={m} /> : null}
      {m.step === 4 ? <ReviewStepView m={m} /> : null}
      {m.step === 5 ? <DoneStepView m={m} /> : null}
    </>
  );
}
