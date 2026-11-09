import type { ComponentChildren } from "preact";
import type { Store, State } from "./state.js";
import type { AgentSummary, ChannelSummary, SetupProbeItem, SetupProbeSnapshot, SetupProbeState } from "./bridge.js";
import { PRESETS, capBadges, friendlyError, key, type Preset, type WizardPriorities } from "./wizardShared.js";

export function WelcomeStep({ onStart }: { onStart(): void }) {
  return (
    <div class="form">
      <p>Stewart needs at least one <b>model source</b> to work. This wizard sets that up in a few minutes:</p>
      <ul>
        <li><b>Channel</b> — where models come from (Ollama on your machine, an OpenAI-compatible service with an API key, or the Claude CLI).</li>
        <li><b>Agent</b> — one model on one channel.</li>
        <li><b>Role</b> — a job (orchestrator, planner, code-writer…). Each role is given the best-suited agent.</li>
      </ul>
      <p class="hint">You can re-run this any time from Settings → Run setup. Prefer to configure by hand? Close this and use the tabs below.</p>
      <div class="row"><button class="send" onClick={onStart}>Start</button></div>
    </div>
  );
}

function NewChannelForm({
  preset, chId, baseUrl, apiKey, onPickPreset, onChId, onBaseUrl, onApiKey, onAddChannel,
}: {
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
      <div class="row"><button class="small" disabled={!chId.trim()} onClick={onAddChannel}>Add this channel</button></div>
    </div>
  );
}

function ChannelStatusRow({ channel, test, onRetest }: { channel: ChannelSummary; test: State["channelTest"][string] | undefined; onRetest(): void }) {
  return (
    <div class="summary">
      <b>{channel.id}</b> ({channel.type}) {test ? (test.ok ? <span>✓ {test.models?.length ?? 0} models</span> : <span class="fail">✗ {friendlyError(channel.type, test.error)}</span>) : <span class="hint">testing…</span>}
      <button class="small" onClick={onRetest}>Retest</button>
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
          onAddChannel={onAddChannel}
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

const PROBE_STATE_VIEWS: Record<SetupProbeState, (item: SetupProbeItem, badges: string) => ComponentChildren> = {
  queued: () => <span class="hint">queued</span>,
  running: () => <span class="hint">probing…</span>,
  green: (_item, badges) => <span>✓ passed{badges ? ` · ${badges}` : ""}</span>,
  orange: (item) => <span class="hint">timed out{item.reason ? ` — ${item.reason}` : ""}{(item.attempts ?? 0) > 1 ? ` (try ${item.attempts})` : ""}</span>,
  red: (item) => <span class="fail">✗ {item.reason ?? item.lastReason ?? "failed"}{(item.attempts ?? 0) > 1 ? ` (try ${item.attempts})` : ""}</span>,
  skipped: (item) => <span class="hint">skipped{item.reason ? ` — ${item.reason}` : ""}</span>,
};

function ProbeRow({ item, badges }: { item: SetupProbeItem; badges: string }) {
  return (
    <div class="summary">
      {item.channel}:{item.model} —{" "}
      {PROBE_STATE_VIEWS[item.state](item, badges)}
    </div>
  );
}

function ProbeSummary({ smoke }: { smoke: SetupProbeSnapshot | undefined }) {
  const smokeRan = !!smoke && smoke.status !== "idle";
  return (
    <>
      {smokeRan && smoke.counts.skipped > 0 && smoke.status !== "running" ? <div class="hint">{smoke.counts.skipped} candidate{smoke.counts.skipped === 1 ? "" : "s"} skipped — retry to probe them.</div> : null}
      {smokeRan && smoke.status !== "running" && smoke.green.length === 0 ? (
        <div class="fail">No models passed the smoke test. Check the channels, then retry — or go back and fix the channel setup.</div>
      ) : null}
    </>
  );
}

export function DiscoverStep({
  smoke, pairs, probeBusy, retryable, bench, probeResults, onBench, onAccept, onRetry, onBack, onNext,
}: {
  smoke: SetupProbeSnapshot | undefined;
  pairs: { channel: string; model: string }[];
  probeBusy: boolean;
  retryable: boolean;
  bench: boolean;
  probeResults: State["probeResults"];
  onBench(checked: boolean): void;
  onAccept(): void;
  onRetry(): void;
  onBack(): void;
  onNext(): void;
}) {
  const smokeRan = !!smoke && smoke.status !== "idle";
  return (
    <div class="form">
      <p><b>What to do:</b> Stewart smoke-tests every model one at a time (local models first, ~30s max each). Only passing models can be assigned to roles.</p>
      {smoke?.status === "running" ? (
        <div class="row">
          <button class="small" onClick={onAccept}>
            Accept and continue
          </button>
          <span class="hint">stops probing now; recommendation uses the green results so far</span>
        </div>
      ) : null}
      <label class="field">
        <span>
          <input type="checkbox" checked={bench} onChange={(e) => onBench((e.target as HTMLInputElement).checked)} /> Measure speed (up to ~2.5 min per model)
        </span>
        <span class="hint">Sends a few test requests to each green model to measure reply speed, tool-call and edit reliability.</span>
      </label>
      {pairs.length === 0 ? <div class="fail">No models found. Go back and check your channels (for Ollama: run <code>ollama pull &lt;model&gt;</code>).</div> : null}
      {smoke?.ranking ? <div class="hint">Ranking remaining models…</div> : null}
      <div aria-live="polite">
        {(smokeRan ? smoke.items : pairs.map((p) => ({ channel: p.channel, model: p.model, state: "queued" as const }))).map((it) => {
          const k = key(it.channel, it.model);
          const badges = it.state === "green" ? capBadges(probeResults[k]?.caps) : "";
          return <ProbeRow key={k} item={it} badges={badges} />;
        })}
      </div>
      <ProbeSummary smoke={smoke} />
      <div class="row">
        {retryable && smoke?.status !== "running" ? <button class="small" onClick={onRetry}>Retry failed</button> : null}
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={pairs.length === 0 || probeBusy} onClick={onNext}>Next: choose evaluator</button>
      </div>
    </div>
  );
}

export function EvaluatorStep({
  evalMode, onEvalMode, eligiblePairs, evaluator, evalSel, onEvaluator, priorities, onPriorities, typicalWork, onTypicalWork, onBuild, onBack,
}: {
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
}) {
  const evaluatorValue = evaluator || evalSel || (eligiblePairs[0] ? key(eligiblePairs[0].channel, eligiblePairs[0].model) : "");
  return (
    <div class="form">
      <p><b>What to do:</b> decide who matches models to roles. <b>Rules only</b> needs no model and always works. <b>AI refine</b> asks a model you pick to adjust the proposal (a bigger model gives better choices); its picks are still checked against each role's hard requirements.</p>
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
      <div class="row">
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" onClick={onBuild}>Build proposal</button>
      </div>
    </div>
  );
}
