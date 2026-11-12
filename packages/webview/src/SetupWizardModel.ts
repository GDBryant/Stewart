import { useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "./bridge.js";
import { recommendArgs, rowRef } from "./wizardShared.js";
import { useWizardChannelForm, useWizardDerived, useWizardPreferences, useWizardProbes } from "./wizardDerived.js";
import { buildAgentsForRoles } from "./wizardApply.js";

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
  const [chainEdits, setChainEdits] = useState<Record<string, string[]>>({});
  const [source, setSource] = useState<"existing" | "new">(channels.length > 0 ? "existing" : "new");
  const [evalChannel, setEvalChannel] = useState("");
  const channelForm = useWizardChannelForm({ store, channels });
  const prefs = useWizardPreferences(store);
  const derived = useWizardDerived({ store, channels, agents, source, added: channelForm.added, evalChannel, evaluator });
  useWizardProbes({ store, step, enabled: derived.enabled, tests: derived.tests, probeSig: derived.probeSig, pairs: derived.pairs, evalSel: derived.evalSel });
  return {
    step, setStep, evalMode, setEvalMode, evaluator, setEvaluator, bench, setBench,
    edits, setEdits, chainEdits, setChainEdits, source, setSource, evalChannel, setEvalChannel, ...channelForm, ...prefs, ...derived,
  };
}

type WizardInputs = ReturnType<typeof useWizardInputs>;

/** Recommendation/apply actions built on the inputs. Plain functions, no hooks. */
function moveRef(cur: string[], ref: string, dir: -1 | 1): string[] {
  const i = cur.indexOf(ref);
  const j = i + dir;
  if (i < 1 || j < 1 || j >= cur.length) return cur;
  const next = [...cur];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function useWizardActions({ store, channels, agents, roles }: SetupWizardProps, m: WizardInputs) {
  const rec = store.state.recommendation;
  const row = (role: string) => rowRef(rec, m.edits, role);
  const buildProposal = () => {
    m.setEdits({});
    store.recommend(recommendArgs({ evalMode: m.evalMode, evaluator: m.evaluator, evalSel: m.evalSel, eligiblePairs: m.eligiblePairs, priorities: m.priorities, typicalWork: m.typicalWork, bench: m.bench }));
    m.setStep(4);
  };
  const chainFor = (role: string): string[] => {
    const primary = row(role);
    const base = m.chainEdits[role] ?? (rec?.assignments.find((a) => a.role === role)?.chain ?? []).map((c) => `${c.channel}:${c.model}`);
    const rest = base.filter((r) => r && r !== primary);
    return primary ? [primary, ...rest].slice(0, 3) : rest;
  };
  const apply = () => {
    if (!rec) return;
    const chosen = roles.map((r) => ({ role: r.id, ref: row(r.id) }));
    const chains = roles.map((r) => ({ role: r.id, refs: chainFor(r.id) })).filter((c) => c.refs.length > 0);
    const { agents: nextAgents, roles: nextRoles } = buildAgentsForRoles({ agents, channels, roles, chosen, probeResults: store.state.probeResults, chains });
    store.setupApply({
      "agents.yaml": stringify({ version: 1, items: nextAgents }, null, 2),
      "roles.yaml": stringify({ version: 1, items: nextRoles }, null, 2),
    });
    store.dismissRecommendation();
    m.setStep(5);
  };
  const statusChannels = m.source === "existing" ? m.enabled : m.enabled.filter((c) => m.added.has(c.id));
  const onChainEdit = (role: string, next: string[]) => m.setChainEdits({ ...m.chainEdits, [role]: next });
  return { rec, row, buildProposal, apply, statusChannels, chainFor,
    onChainMove: (role: string, ref: string, dir: -1 | 1) => onChainEdit(role, moveRef(chainFor(role), ref, dir)),
    onChainRemove: (role: string, ref: string) => onChainEdit(role, chainFor(role).filter((r) => r !== ref)) };
}

export function useSetupWizardModel(props: SetupWizardProps) {
  const inputs = useWizardInputs(props);
  const actions = useWizardActions(props, inputs);
  return { ...props, ...inputs, ...actions };
}

export type SetupWizardModel = ReturnType<typeof useSetupWizardModel>;
