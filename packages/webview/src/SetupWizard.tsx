import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "./bridge.js";
import { PRESETS, STEPS, friendlyError } from "./wizardShared.js";
import { useSetupWizardModel } from "./SetupWizardModel.js";
import { StepSwitch } from "./SetupWizardViews.js";

export { PRESETS, STEPS, friendlyError };

export function SetupWizard({ store, channels, agents, roles }: { store: Store; channels: ChannelSummary[]; agents: AgentSummary[]; roles: RoleSummary[] }) {
  const m = useSetupWizardModel({ store, channels, agents, roles });
  return (
    <div class="card wizard">
      <div class="card-title">
        <b>First-run setup wizard</b>
        <span class="spacer" />
        <span class="hint">Step {m.step + 1} of {STEPS.length}: {STEPS[m.step]}</span>
        <button class="small" onClick={() => store.setWizardOpen(false)}>Close</button>
      </div>
      <progress max={STEPS.length - 1} value={m.step} aria-label="setup progress" />
      <StepSwitch m={m} />
    </div>
  );
}
