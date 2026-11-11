import { useEffect, useState } from "preact/hooks";
import type { Store, State } from "./state.js";
import { Spinner } from "./Busy.js";
import type { AgentSummary, ChannelSummary } from "./bridge.js";
import { PRESETS, friendlyError, type Preset } from "./wizardShared.js";
import { ChannelDot, channelColor } from "./channelColors.js";

function NewChannelForm({
  preset, chId, baseUrl, apiKey, onPickPreset, onChId, onBaseUrl, onApiKey, onAddChannel, adding,
}: {
  adding: boolean;
  preset: Preset;
  chId: string;
  baseUrl: string;
  apiKey: string;
  onPickPreset(label: string): void;
  onChId(v: string): void;
  onBaseUrl(v: string): void;
  onApiKey(v: string): void;
  onAddChannel(): void;
}) {
  return (
    <div>
      <p class="hint">Choose where your models live, fill the details, press the Add button.</p>
      <label class="field">
        <span>Channel type</span>
        <select aria-label="channel preset" value={preset.label} onChange={(e) => onPickPreset((e.target as HTMLSelectElement).value)}>
          {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>
      </label>
      <div class="hint">{preset.help}</div>
      <label class="field"><span>Channel name</span><input aria-label="channel id" value={chId} onInput={(e) => onChId((e.target as HTMLInputElement).value)} /></label>
      {preset.type !== "claude-cli" ? (
        <label class="field"><span>Base URL</span><input aria-label="base url" placeholder="https://host/v1" value={baseUrl} onInput={(e) => onBaseUrl((e.target as HTMLInputElement).value)} /></label>
      ) : null}
      {preset.type === "openai-compatible" ? (
        <label class="field">
          <span>API key{preset.needsKey ? "" : " (optional)"}</span>
          <input aria-label="api key" type="password" value={apiKey} onInput={(e) => onApiKey((e.target as HTMLInputElement).value)} />
          <span class="hint">Stored in your IDE's secret storage, not in config files.</span>
        </label>
      ) : null}
      <div class="row"><button class="small" disabled={!chId.trim() || adding} aria-busy={adding ? "true" : undefined} onClick={onAddChannel}>{adding ? <><Spinner /> Adding…</> : "Add this channel"}</button></div>
    </div>
  );
}

function ChannelStatusRow({ channel, test, onRetest }: { channel: ChannelSummary; test: State["channelTest"][string] | undefined; onRetest(): void }) {
  const [retesting, setRetesting] = useState(false);
  useEffect(() => setRetesting(false), [test]);
  return (
    <div class="summary">
      <ChannelDot channel={channel.id} title={`Channel colour ${channelColor(channel.id)}`} />
      <b>{channel.id}</b> ({channel.type}) {test ? (test.ok ? <span>✓ {test.models?.length ?? 0} models</span> : <span class="fail">✗ {friendlyError(channel.type, test.error)}</span>) : <span class="hint"><Spinner /> testing…</span>}
      <button
        class="small"
        disabled={retesting}
        aria-busy={retesting ? "true" : undefined}
        onClick={() => {
          setRetesting(true);
          onRetest();
        }}
      >
        {retesting ? <><Spinner /> Retesting…</> : "Retest"}
      </button>
    </div>
  );
}

function EvaluatorPicker({
  evalChannels, evalChan, evalChanObj, evalAgents, evalOptions, evalSel, source, onEvalChannel, onEvaluator,
}: {
  evalChannels: ChannelSummary[];
  evalChan: string;
  evalChanObj: ChannelSummary | undefined;
  evalAgents: AgentSummary[];
  evalOptions: { v: string; label: string }[];
  evalSel: string;
  source: "existing" | "new";
  onEvalChannel(v: string): void;
  onEvaluator(v: string): void;
}) {
  return (
    <div>
      <label class="field">
        <span>Evaluator channel</span>
        <select aria-label="evaluator channel" value={evalChan} onChange={(e) => onEvalChannel((e.target as HTMLSelectElement).value)}>
          {evalChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
            </option>
          ))}
        </select>
      </label>
      {source === "existing" && evalChanObj && evalAgents.length === 0 ? (
        <div class="hint">No agents on this channel; use Add a new channel or pick it after setup</div>
      ) : null}
      <label class="field">
        <span>Evaluator agent</span>
        <select aria-label="evaluator agent" value={evalSel} onChange={(e) => onEvaluator((e.target as HTMLSelectElement).value)}>
          {evalOptions.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ChannelsStep({
  store, hasChannels, source, onSource, preset, chId, baseUrl, apiKey,
  onPickPreset, onChId, onBaseUrl, onApiKey, onAddChannel,
  statusChannels, tests, evalChannels, evalChan, evalChanObj, evalAgents, evalOptions, evalSel,
  onEvalChannel, onEvaluator, nextDisabled, onBack, onNext,
}: {
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
}) {
  const [addingId, setAddingId] = useState("");
  const addedVisible = !!addingId && statusChannels.some((c) => c.id === addingId);
  useEffect(() => {
    if (addedVisible) setAddingId("");
  }, [addedVisible]);
  const adding = !!addingId && !addedVisible;
  return (
    <div class="form">
      <p><b>What to do:</b> pick the channel and agent that will run the evaluation of all available models.</p>
      {hasChannels ? (
        <div class="row">
          <label><input type="radio" name="source" aria-label="source existing" checked={source === "existing"} onChange={() => onSource("existing")} /> Use existing channels</label>
          <label><input type="radio" name="source" aria-label="source new" checked={source === "new"} onChange={() => onSource("new")} /> Add a new channel</label>
        </div>
      ) : null}
      {source === "new" ? (
        <NewChannelForm
          preset={preset}
          chId={chId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          onPickPreset={onPickPreset}
          onChId={onChId}
          onBaseUrl={onBaseUrl}
          onApiKey={onApiKey}
          onAddChannel={() => {
            setAddingId(chId);
            onAddChannel();
          }}
          adding={adding}
        />
      ) : null}
      {statusChannels.map((c) => (
        <ChannelStatusRow key={c.id} channel={c} test={tests[c.id]} onRetest={() => store.testChannel(c.id)} />
      ))}
      {evalChannels.length ? (
        <EvaluatorPicker
          evalChannels={evalChannels}
          evalChan={evalChan}
          evalChanObj={evalChanObj}
          evalAgents={evalAgents}
          evalOptions={evalOptions}
          evalSel={evalSel}
          source={source}
          onEvalChannel={onEvalChannel}
          onEvaluator={onEvaluator}
        />
      ) : null}
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={nextDisabled} onClick={onNext}>Next: discover models</button>
      </div>
    </div>
  );
}
