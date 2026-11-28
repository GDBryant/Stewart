import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "./bridge.js";
import { recommendArgs, rowRef } from "./wizardShared.js";
import { passedPairs, useWizardChannelForm, useWizardDerived, useWizardPreferences, useWizardProbes } from "./wizardDerived.js";
import { buildAgentsForRoles } from "./wizardApply.js";
import { divertCandidates as divertCandidatesFor, fallbackToEscalation, initialFallback, type FallbackPreference } from "./wizardDeepThink.js";

export interface SetupWizardProps {
  store: Store;
  channels: ChannelSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
}

/** Wizard step state plus the derived channel/probe views. Hook call order is fixed. */
function useWizardInputs({ store, channels, agents }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [evalMode, setEvalMode] = useState<"rules" | "ai">("rules");
  const [evaluator, setEvaluator] = useState("");
  const [bench, setBench] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [secondaryEdits, setSecondaryEdits] = useState<Record<string, string>>({});
  const [source, setSource] = useState<"existing" | "new">(channels.length > 0 ? "existing" : "new");
  const [fallback, setFallback] = useState<FallbackPreference>(() => initialFallback(store.state.config?.summary.settings));
  const [evalChannel, setEvalChannel] = useState("");
  // Unticked existing channels; empty by default = every channel included.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggleChannel = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const channelForm = useWizardChannelForm({ store, channels });
  const prefs = useWizardPreferences(store);
  const derived = useWizardDerived({ store, channels, agents, source, added: channelForm.added, evalChannel, evaluator, excluded });
  useWizardProbes({ store, step, enabled: derived.enabled, tests: derived.tests, probeSig: derived.probeSig, pairs: derived.pairs, evalSel: derived.evalSel, excluded });
  return {
    step, setStep, evalMode, setEvalMode, evaluator, setEvaluator, bench, setBench,
    edits, setEdits, secondaryEdits, setSecondaryEdits, source, setSource, fallback, setFallback, evalChannel, setEvalChannel, excluded, toggleChannel, ...channelForm, ...prefs, ...derived,
  };
}

type WizardInputs = ReturnType<typeof useWizardInputs>;

/** Recommendation/apply actions built on the inputs. Plain functions, no hooks. */
function useWizardActions({ store, channels, agents, roles }: SetupWizardProps, m: WizardInputs) {
  const rec = store.state.recommendation;
  const rosterIds = new Set(roles.map((r) => r.id));
  const candidateRoles = [...roles, ...(store.state.config?.summary.roleTemplates ?? []).filter((t) => !rosterIds.has(t.id))];
  const row = (role: string) => rowRef(rec, m.edits, role);
  const buildProposal = () => {
    m.setEdits({});
    store.recommend(recommendArgs({ evalMode: m.evalMode, evaluator: m.evaluator, evalSel: m.evalSel, eligiblePairs: m.eligiblePairs, priorities: m.priorities, typicalWork: m.typicalWork, bench: m.bench, excluded: m.excluded }));
    m.setStep(4);
  };
  const secondaryFor = (role: string): string => {
    const edited = m.secondaryEdits[role];
    if (edited !== undefined) return edited === row(role) ? "" : edited;
    const sec = rec?.assignments.find((a) => a.role === role)?.secondary;
    const ref = sec ? `${sec.channel}:${sec.model}` : "";
    return ref === row(role) ? "" : ref;
  };
  const apply = () => {
    if (!rec) return;
    const chosen = candidateRoles.map((r) => ({ role: r.id, ref: row(r.id) }));
    const secondaries = candidateRoles.map((r) => ({ role: r.id, ref: secondaryFor(r.id) })).filter((c) => c.ref);
    const { agents: nextAgents, roles: nextRoles } = buildAgentsForRoles({ agents, channels, roles: candidateRoles, chosen, probeResults: store.state.probeResults, secondaries, passed: passedPairs(m.smoke, m.eligiblePairs), rosterIds });
    store.setupApply(
      {
        "agents.yaml": stringify({ version: 1, items: nextAgents }, null, 2),
        "roles.yaml": stringify({ version: 1, items: nextRoles }, null, 2),
      },
      fallbackToEscalation(m.fallback),
    );
    store.dismissRecommendation();
    m.setStep(6);
  };
  const statusChannels = m.source === "existing" ? m.enabled : m.enabled.filter((c) => m.added.has(c.id));
  const divertCandidates = divertCandidatesFor(agents, channels, store.state.probeResults);
  return { rec, row, buildProposal, apply, statusChannels, divertCandidates, secondaryFor, candidateRoles,
    onSecondaryChange: (role: string, ref: string) => m.setSecondaryEdits({ ...m.secondaryEdits, [role]: ref }) };
}

export function useSetupWizardModel(props: SetupWizardProps) {
  const inputs = useWizardInputs(props);
  const actions = useWizardActions(props, inputs);
  return { ...props, ...inputs, ...actions };
}

export type SetupWizardModel = ReturnType<typeof useSetupWizardModel>;
