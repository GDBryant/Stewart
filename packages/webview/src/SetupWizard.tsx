import { useEffect, useState } from "preact/hooks";
import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "./bridge.js";

type Preset = { label: string; id: string; type: string; baseUrl: string; needsKey: boolean; help: string };

export const PRESETS: Preset[] = [
  { label: "Ollama (local)", id: "local-ollama", type: "ollama", baseUrl: "http://localhost:11434", needsKey: false, help: "Free, runs on your machine. Install from ollama.com, then run `ollama pull <model>` (for example qwen3 or qwen2.5-coder)." },
  { label: "OpenAI", id: "openai", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsKey: true, help: "Paste an API key from platform.openai.com. Usage is billed by OpenAI." },
  { label: "OpenRouter", id: "openrouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, help: "One key, many hosted models. Create a key at openrouter.ai." },
  { label: "LM Studio (local)", id: "lmstudio", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", needsKey: false, help: "Start the LM Studio local server first. A key is usually not needed." },
  { label: "Other OpenAI-compatible", id: "custom", type: "openai-compatible", baseUrl: "", needsKey: true, help: "Any server that speaks the OpenAI API. Enter its URL (ending in /v1) and key." },
  { label: "Claude CLI", id: "claude", type: "claude-cli", baseUrl: "", needsKey: false, help: "Uses the `claude` command already logged in on this machine. No key needed." },
];

export const STEPS = ["Welcome", "Channels", "Discover", "Evaluator", "Review", "Done"] as const;

const key = (c: string, m: string) => `${c}:${m}`;

function channelModels(store: Store, c: ChannelSummary): string[] {
  const t = store.state.channelTest[c.id];
  return [...new Set([...(t?.ok ? t.models ?? [] : []), ...(c.extraModels ?? [])])];
}

function capBadges(caps?: Record<string, unknown>): string {
  if (!caps) return "";
  const out: string[] = [];
  if (caps.tools) out.push(`tools:${caps.tools}`);
  if (caps.vision) out.push("vision");
  if (caps.reasoning) out.push("reasoning");
  if (caps.imageGen) out.push("image-gen");
  if (typeof caps.contextTokens === "number") out.push(`${Math.round(caps.contextTokens / 1000)}k ctx`);
  return out.join(" · ");
}

/** Maps raw channel-test errors to something a new user can act on. */
export function friendlyError(type: string, err?: string): string {
  const e = err ?? "";
  if (/401|403|unauthor|invalid.*key/i.test(e)) return "The server rejected the API key. Check it and try again.";
  if (/ECONNREFUSED|fetch failed|connect|ENOTFOUND/i.test(e)) return type === "ollama" ? "Cannot reach Ollama. Is it installed and running (`ollama serve`)?" : "Cannot reach the server. Check the URL and that it is running.";
  if (/404/.test(e)) return "Server answered but the path was not found. Check the base URL (OpenAI-compatible URLs usually end in /v1).";
  return e || "Connection failed.";
}

export function SetupWizard({ store, channels, agents, roles }: { store: Store; channels: ChannelSummary[]; agents: AgentSummary[]; roles: RoleSummary[] }) {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [chId, setChId] = useState(PRESETS[0].id);
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [evalMode, setEvalMode] = useState<"rules" | "ai">("rules");
  const [evaluator, setEvaluator] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const tests = store.state.channelTest;
  const enabled = channels.filter((c) => c.enabled);
  const okChannels = enabled.filter((c) => tests[c.id]?.ok);
  const pairs = okChannels.flatMap((c) => channelModels(store, c).map((m) => ({ channel: c.id, model: m })));

  // Test every configured channel once it appears (config.set rebuilds the live channels first).
  useEffect(() => {
    if (step !== 1) return;
    for (const c of enabled) if (!tests[c.id]) store.testChannel(c.id);
  }, [step, enabled.map((c) => c.id).join()]);

  // Discover: probe each model once.
  useEffect(() => {
    if (step !== 2) return;
    for (const p of pairs) if (!store.state.probeResults[key(p.channel, p.model)]) store.probeModel(p.channel, p.model);
  }, [step, pairs.map((p) => key(p.channel, p.model)).join()]);

  const pickPreset = (label: string) => {
    const p = PRESETS.find((x) => x.label === label) ?? PRESETS[0];
    setPreset(p);
    setChId(channels.some((c) => c.id === p.id) ? `${p.id}-2` : p.id);
    setBaseUrl(p.baseUrl);
    setApiKey("");
  };

  const addChannel = () => {
    if (!chId.trim()) return;
    const ref = apiKey ? `channel-${chId}` : undefined;
    const next = [...channels.filter((c) => c.id !== chId), { id: chId, type: preset.type, enabled: true, ...(baseUrl ? { baseUrl } : {}), ...(ref ? { secretRef: ref } : {}) }];
    if (ref) store.setSecret(ref, apiKey); // key goes to the IDE secret store, never to YAML
    store.saveFile("channels.yaml", stringify({ version: 1, items: next }, null, 2));
    setApiKey("");
    pickPreset(preset.label);
  };

  const rec = store.state.recommendation;
  const row = (role: string) => {
    const a = rec?.assignments.find((x) => x.role === role);
    return edits[role] ?? (a ? key(a.channel, a.model) : "");
  };
  const buildProposal = () => {
    setEdits({});
    const f = evaluator || (pairs[0] ? key(pairs[0].channel, pairs[0].model) : "");
    const i = f.indexOf(":");
    const ev = evalMode === "ai" && f ? { evaluator: { channel: f.slice(0, i), model: f.slice(i + 1) } } : {};
    store.recommend({ mode: evalMode, ...ev });
    setStep(4);
  };

  const apply = () => {
    if (!rec) return;
    const chosen = roles.map((r) => ({ role: r.id, ref: row(r.id) }));
    const pairToAgent = new Map<string, string>();
    const nextAgents = new Map(agents.map((a) => [a.id, { ...a }] as const));
    for (const { ref } of chosen) {
      if (!ref || pairToAgent.has(ref)) continue;
      const i = ref.indexOf(":");
      const ch = ref.slice(0, i);
      const model = ref.slice(i + 1);
      const existing = agents.find((a) => a.channel === ch && a.model === model);
      if (existing) {
        pairToAgent.set(ref, existing.id);
        continue;
      }
      const base = `${ch}-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      let id = base;
      for (let n = 2; nextAgents.has(id); n++) id = `${base}-${n}`;
      const type = channels.find((c) => c.id === ch)?.type;
      nextAgents.set(id, { id, channel: ch, model, effort: "medium", billing: type === "ollama" ? "free" : type === "claude-cli" ? "reported" : "unmetered" });
      pairToAgent.set(ref, id);
    }
    const nextRoles = roles.map((r) => {
      const ref = chosen.find((c) => c.role === r.id)?.ref;
      return ref ? { ...r, agent: pairToAgent.get(ref), enabled: true } : { ...r, enabled: false };
    });
    store.saveFile("agents.yaml", stringify({ version: 1, items: [...nextAgents.values()] }, null, 2));
    store.saveFile("roles.yaml", stringify({ version: 1, items: nextRoles }, null, 2));
    store.dismissRecommendation();
    setStep(5);
  };

  const next = (label: string, to: number, disabled = false) => (
    <button class="send" disabled={disabled} onClick={() => setStep(to)}>{label}</button>
  );

  return (
    <div class="card wizard">
      <div class="card-title">
        <b>First-run setup wizard</b>
        <span class="spacer" />
        <span class="hint">Step {step + 1} of {STEPS.length}: {STEPS[step]}</span>
        <button class="small" onClick={() => store.setWizardOpen(false)}>Close</button>
      </div>
      <progress max={STEPS.length - 1} value={step} aria-label="setup progress" />

      {step === 0 ? (
        <div class="form">
          <p>Stewart needs at least one <b>model source</b> to work. This wizard sets that up in a few minutes:</p>
          <ul>
            <li><b>Channel</b> — where models come from (Ollama on your machine, an OpenAI-compatible service with an API key, or the Claude CLI).</li>
            <li><b>Agent</b> — one model on one channel.</li>
            <li><b>Role</b> — a job (orchestrator, planner, code-writer…). Each role is given the best-suited agent.</li>
          </ul>
          <p class="hint">You can re-run this any time from Settings → Run setup. Prefer to configure by hand? Close this and use the tabs below.</p>
          <div class="row">{next("Start", 1)}</div>
        </div>
      ) : null}

      {step === 1 ? (
        <div class="form">
          <p><b>What to do:</b> choose where your models live, fill the details, press the Add button. Add as many as you like, then continue once at least one shows ✓.</p>
          <label class="field">
            <span>Channel type</span>
            <select aria-label="channel preset" value={preset.label} onChange={(e) => pickPreset((e.target as HTMLSelectElement).value)}>
              {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
          </label>
          <div class="hint">{preset.help}</div>
          <label class="field"><span>Channel name</span><input aria-label="channel id" value={chId} onInput={(e) => setChId((e.target as HTMLInputElement).value)} /></label>
          {preset.type !== "claude-cli" ? (
            <label class="field"><span>Base URL</span><input aria-label="base url" placeholder="https://host/v1" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} /></label>
          ) : null}
          {preset.type === "openai-compatible" ? (
            <label class="field">
              <span>API key{preset.needsKey ? "" : " (optional)"}</span>
              <input aria-label="api key" type="password" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
              <span class="hint">Stored in your IDE's secret storage, not in config files.</span>
            </label>
          ) : null}
          <div class="row"><button class="small" disabled={!chId.trim()} onClick={addChannel}>Add this channel</button></div>
          {enabled.map((c) => {
            const t = tests[c.id];
            return (
              <div key={c.id} class="summary">
                <b>{c.id}</b> ({c.type}) {t ? (t.ok ? <span>✓ {t.models?.length ?? 0} models</span> : <span class="fail">✗ {friendlyError(c.type, t.error)}</span>) : <span class="hint">testing…</span>}
                <button class="small" onClick={() => store.testChannel(c.id)}>Retest</button>
              </div>
            );
          })}
          <div class="row">
            <button class="small" onClick={() => setStep(0)}>Back</button>
            {next("Next: discover models", 2, okChannels.length === 0)}
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div class="form">
          <p><b>What to do:</b> wait while Stewart checks what each model can do (tools, vision, reasoning, context size). Failed checks are fine — those models just get safe defaults.</p>
          {pairs.length === 0 ? <div class="fail">No models found. Go back and check your channels (for Ollama: run <code>ollama pull &lt;model&gt;</code>).</div> : null}
          {pairs.map((p) => {
            const r = store.state.probeResults[key(p.channel, p.model)];
            return (
              <div key={key(p.channel, p.model)} class="summary">
                {p.channel}:{p.model} — {r ? (r.ok ? <span>{capBadges(r.caps) || "no special abilities reported"}</span> : <span class="hint">probe failed, using defaults</span>) : <span class="hint">probing…</span>}
              </div>
            );
          })}
          <div class="row">
            <button class="small" onClick={() => setStep(1)}>Back</button>
            {next("Next: choose evaluator", 3, pairs.length === 0)}
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div class="form">
          <p><b>What to do:</b> decide who matches models to roles. <b>Rules only</b> needs no model and always works. <b>AI refine</b> asks a model you pick to adjust the proposal (a bigger model gives better choices); its picks are still checked against each role's hard requirements.</p>
          <label class="field"><span><input type="radio" name="evalmode" checked={evalMode === "rules"} onChange={() => setEvalMode("rules")} /> Rules only (recommended)</span></label>
          <label class="field"><span><input type="radio" name="evalmode" checked={evalMode === "ai"} onChange={() => setEvalMode("ai")} /> AI refine</span></label>
          {evalMode === "ai" ? (
            <label class="field">
              <span>Evaluator model</span>
              <select aria-label="evaluator" value={evaluator || (pairs[0] ? key(pairs[0].channel, pairs[0].model) : "")} onChange={(e) => setEvaluator((e.target as HTMLSelectElement).value)}>
                {pairs.map((p) => <option key={key(p.channel, p.model)} value={key(p.channel, p.model)}>{p.channel}:{p.model}</option>)}
              </select>
            </label>
          ) : null}
          <div class="row">
            <button class="small" onClick={() => setStep(2)}>Back</button>
            <button class="send" onClick={buildProposal}>Build proposal</button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div class="form">
          <p><b>What to do:</b> check who does what. Change any row, or leave a role off. Warnings mean the model is weak for that role.</p>
          {store.state.recommendBusy ? <div class="hint">Evaluating…</div> : null}
          {store.state.recommendError ? (
            <div class="fail">
              {store.state.recommendError}
              {evalMode === "ai" ? <button class="small" onClick={() => { setEvalMode("rules"); store.recommend({ mode: "rules" }); }}>Use rules instead</button> : null}
            </div>
          ) : null}
          {rec ? (
            <div>
              {rec.researcher ? <div class="hint">Refined by {rec.researcher.channel}:{rec.researcher.model}</div> : null}
              {roles.map((r) => {
                const a = rec.assignments.find((x) => x.role === r.id);
                const un = rec.unfilled?.find((x) => x.role === r.id);
                return (
                  <div key={r.id} class="summary" title={a?.reason}>
                    <b>{r.id}</b>{" "}
                    <select aria-label={`role ${r.id}`} value={row(r.id)} onChange={(e) => setEdits({ ...edits, [r.id]: (e.target as HTMLSelectElement).value })}>
                      <option value="">(disabled)</option>
                      {pairs.map((p) => <option key={key(p.channel, p.model)} value={key(p.channel, p.model)}>{p.channel}:{p.model}</option>)}
                    </select>
                    {a?.reason ? <span class="hint"> — {a.reason}</span> : null}
                    {un && !edits[r.id] ? <span class="hint"> — disabled: {un.reason}</span> : null}
                    {a?.warnings?.map((w) => <div key={w} class="fail">⚠ {w}</div>)}
                  </div>
                );
              })}
              {rec.dropped?.length ? <div class="hint">Ignored AI picks: {rec.dropped.join("; ")}</div> : null}
            </div>
          ) : null}
          <div class="row">
            <button class="small" onClick={() => setStep(3)}>Back</button>
            <button class="send" disabled={!rec || store.state.recommendBusy} onClick={apply}>Apply</button>
          </div>
        </div>
      ) : null}

      {step === 5 ? (
        <div class="form">
          <p><b>Setup complete.</b> Roles now use the agents you approved. Go to Chat and try: <i>“Summarise this project’s structure.”</i></p>
          <p class="hint">Re-run any time from Settings → Run setup. Fine-tune channels, agents and roles in their tabs.</p>
          <div class="row"><button class="send" onClick={() => store.setWizardOpen(false)}>Finish</button></div>
        </div>
      ) : null}
    </div>
  );
}
