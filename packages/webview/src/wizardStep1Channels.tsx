import { useEffect, useState } from "preact/hooks";
import type { Store, State } from "./state.js";
import type { AgentSummary, ChannelSummary } from "./bridge.js";
import type { Preset } from "./wizardShared.js";
import { NewChannelForm, ChannelStatusRow, EvaluatorPicker } from "./wizardStep1Parts.js";

export interface ChannelsStepProps {
  store: Store;
  hasChannels: boolean;
  source: "existing" | "new";
  onSource(source: "existing" | "new"): void;
  preset: Preset;
  chId: string;
  baseUrl: string;
  apiKey: string;
  onPickPreset(label: string): void;
  onChId(v: string): void;
  onBaseUrl(v: string): void;
  onApiKey(v: string): void;
  onAddChannel(): void;
  /** Why the last add-channel request failed (cleared when the next starts). */
  addError?: string;
  statusChannels: ChannelSummary[];
  tests: State["channelTest"];
  evalChannels: ChannelSummary[];
  evalChan: string;
  evalChanObj: ChannelSummary | undefined;
  evalAgents: AgentSummary[];
  evalOptions: { v: string; label: string }[];
  evalSel: string;
  onEvalChannel(v: string): void;
  onEvaluator(v: string): void;
  nextDisabled: boolean;
  onBack(): void;
  onNext(): void;
}

/** Tracks the channel id whose add request is in flight; clears once that id shows up in status or an error arrives. */
function useAddingChannel(statusChannels: ChannelSummary[], addError?: string) {
  const [addingId, setAddingId] = useState("");
  const addedVisible = !!addingId && statusChannels.some((c) => c.id === addingId);
  useEffect(() => {
    if (addedVisible) setAddingId("");
  }, [addedVisible]);
  return { adding: !!addingId && !addedVisible && !addError, startAdd: setAddingId };
}

function SourceToggle({ source, onSource }: { source: "existing" | "new"; onSource(source: "existing" | "new"): void }) {
  return (
    <div class="row">
      <label><input type="radio" name="source" aria-label="source existing" checked={source === "existing"} onChange={() => onSource("existing")} /> Use existing channels</label>
      <label><input type="radio" name="source" aria-label="source new" checked={source === "new"} onChange={() => onSource("new")} /> Add a new channel</label>
    </div>
  );
}

export function ChannelsStep(props: ChannelsStepProps) {
  const { store, hasChannels, source, onSource, statusChannels, tests, addError, nextDisabled, onBack, onNext, onAddChannel } = props;
  const { adding, startAdd } = useAddingChannel(statusChannels, addError);
  const newChannel = {
    preset: props.preset, chId: props.chId, baseUrl: props.baseUrl, apiKey: props.apiKey, error: addError,
    onPickPreset: props.onPickPreset, onChId: props.onChId, onBaseUrl: props.onBaseUrl, onApiKey: props.onApiKey,
  };
  const evaluator = {
    evalChannels: props.evalChannels, evalChan: props.evalChan, evalChanObj: props.evalChanObj, evalAgents: props.evalAgents,
    evalOptions: props.evalOptions, evalSel: props.evalSel, source, onEvalChannel: props.onEvalChannel, onEvaluator: props.onEvaluator,
  };
  return (
    <div class="form">
      <p><b>What to do:</b> pick the channel and agent that will run the evaluation of all available models.</p>
      {hasChannels ? <SourceToggle source={source} onSource={onSource} /> : null}
      {source === "new" ? (
        <NewChannelForm {...newChannel} adding={adding} onAddChannel={() => { startAdd(props.chId); onAddChannel(); }} />
      ) : null}
      {statusChannels.map((c) => (
        <ChannelStatusRow key={c.id} channel={c} test={tests[c.id]} onRetest={() => store.testChannel(c.id)} />
      ))}
      {props.evalChannels.length ? <EvaluatorPicker {...evaluator} /> : null}
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={nextDisabled} onClick={onNext}>Next: discover models</button>
      </div>
    </div>
  );
}
