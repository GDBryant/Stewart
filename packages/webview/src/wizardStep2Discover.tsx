import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { State } from "./state.js";
import { BusyNote, Spinner } from "./Busy.js";
import type { SetupProbeItem, SetupProbeSnapshot, SetupProbeState } from "./bridge.js";
import { capBadges, key } from "./wizardShared.js";

const PROBE_STATE_VIEWS: Record<SetupProbeState, (item: SetupProbeItem, badges: string) => ComponentChildren> = {
  queued: () => <span class="hint">queued</span>,
  running: () => <span class="hint"><Spinner /> probing…</span>,
  green: (item, badges) => (
    <span>
      ✓ passed{badges ? ` · ${badges}` : ""}
      {item.qualified ? ` · qual:${item.qualified.agent === true ? "A✓" : item.qualified.agent === false ? "A✗" : ""}${item.qualified.function === true ? " F✓" : item.qualified.function === false ? " F✗" : ""}` : ""}
    </span>
  ),
  orange: (item) => <span class="hint">timed out{item.reason ? ` — ${item.reason}` : ""}{(item.attempts ?? 0) > 1 ? ` (try ${item.attempts})` : ""}</span>,
  red: (item) => <span class="fail">✗ {item.reason ?? item.lastReason ?? "failed"}{(item.attempts ?? 0) > 1 ? ` (try ${item.attempts})` : ""}</span>,
  skipped: (item) => <span class="hint">skipped{item.reason ? ` — ${item.reason}` : ""}</span>,
};

const DONE_STATES = new Set<SetupProbeState>(["green", "orange", "red", "skipped"]);

type Pair = { channel: string; model: string };

type DiscoverProps = {
  smoke: SetupProbeSnapshot | undefined;
  pairs: Pair[];
  probeBusy: boolean;
  retryable: boolean;
  bench: boolean;
  probeResults: State["probeResults"];
  onBench(checked: boolean): void;
  onAccept(): void;
  onRetry(): void;
  onBack(): void;
  onNext(): void;
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

/** Snapshot items once a smoke run exists, otherwise every candidate pair as queued. */
function listedItems(smoke: SetupProbeSnapshot | undefined, pairs: Pair[]) {
  const smokeRan = !!smoke && smoke.status !== "idle";
  return smokeRan ? smoke.items : pairs.map((p) => ({ channel: p.channel, model: p.model, state: "queued" as const }));
}

function AcceptRow({ onAccept }: { onAccept(): void }) {
  return (
    <div class="row">
      <button class="small" onClick={onAccept}>
        Accept and continue
      </button>
      <span class="hint">stops probing now; recommendation uses the green results so far</span>
    </div>
  );
}

function BenchToggle({ bench, onBench }: { bench: boolean; onBench(checked: boolean): void }) {
  return (
    <label class="field">
      <span>
        <input type="checkbox" checked={bench} onChange={(e) => onBench((e.target as HTMLInputElement).checked)} /> Measure speed (up to ~2.5 min per model)
      </span>
      <span class="hint">Sends a few test requests to each green model to measure reply speed, tool-call and edit reliability.</span>
    </label>
  );
}

function RetryButton({ retrying, onClick }: { retrying: boolean; onClick(): void }) {
  return (
    <button
      class="small"
      disabled={retrying}
      aria-busy={retrying ? "true" : undefined}
      onClick={onClick}
    >
      {retrying ? <><Spinner /> Retrying…</> : "Retry failed"}
    </button>
  );
}

function ProbeList({ smoke, pairs, probeResults }: { smoke: SetupProbeSnapshot | undefined; pairs: Pair[]; probeResults: State["probeResults"] }) {
  return (
    <div aria-live="polite">
      {listedItems(smoke, pairs).map((it) => {
        const k = key(it.channel, it.model);
        const badges = it.state === "green" ? capBadges(probeResults[k]?.caps) : "";
        return <ProbeRow key={k} item={it} badges={badges} />;
      })}
    </div>
  );
}

function DiscoverBusy({ smoke, pairs, probeBusy }: { smoke: SetupProbeSnapshot | undefined; pairs: Pair[]; probeBusy: boolean }) {
  const smokeDone = smoke?.status === "running" ? smoke.items.filter((it) => DONE_STATES.has(it.state)).length : 0;
  return (
    <>
      {probeBusy && smoke?.status !== "running" && pairs.length > 0 ? <BusyNote label="Starting model discovery…" /> : null}
      {smoke?.status === "running" ? <BusyNote label={`Smoke-testing models (${smokeDone} of ${smoke.items.length} done)…`} /> : null}
      {smoke?.ranking ? <BusyNote label="Ranking remaining models…" /> : null}
    </>
  );
}

export function DiscoverStep({
  smoke, pairs, probeBusy, retryable, bench, probeResults, onBench, onAccept, onRetry, onBack, onNext,
}: DiscoverProps) {
  const [retrying, setRetrying] = useState(false);
  const smokeRunKey = smoke?.status === "running" ? smoke.runId : 0;
  useEffect(() => {
    if (smokeRunKey) setRetrying(false);
  }, [smokeRunKey]);
  const retry = () => {
    setRetrying(true);
    onRetry();
  };
  return (
    <div class="form">
      <p><b>What to do:</b> Stewart smoke-tests every model one at a time (local models first, ~30s max each). Only passing models can be assigned to roles.</p>
      {smoke?.status === "running" ? <AcceptRow onAccept={onAccept} /> : null}
      <BenchToggle bench={bench} onBench={onBench} />
      {pairs.length === 0 ? <div class="fail">No models found. Go back and check your channels (for Ollama: run <code>ollama pull &lt;model&gt;</code>).</div> : null}
      <DiscoverBusy smoke={smoke} pairs={pairs} probeBusy={probeBusy} />
      <ProbeList smoke={smoke} pairs={pairs} probeResults={probeResults} />
      <ProbeSummary smoke={smoke} />
      <div class="row">
        {retryable && smoke?.status !== "running" ? <RetryButton retrying={retrying} onClick={retry} /> : null}
        <button class="small" onClick={onBack}>Back</button>
        <button class="send" disabled={pairs.length === 0 || probeBusy} onClick={onNext}>Next: choose evaluator</button>
      </div>
    </div>
  );
}
