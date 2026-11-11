import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { State, Store } from "./state.js";
import { ChatView } from "./ChatView.js";
import { SettingsView } from "./SettingsView.js";

function TabButton({ store, view, active, children }: { store: Store; view: State["view"]; active: boolean; children: ComponentChildren }) {
  return <button class={active ? "tab active" : "tab"} onClick={() => store.setView(view)}>{children}</button>;
}

/** The last run's id when its changes can still be reverted, otherwise undefined. */
function revertableRunId(s: State): string | undefined {
  const id = s.lastRunId;
  return id && !s.busyRunId && !s.revertedRuns.includes(id) ? id : undefined;
}

export function App({ store }: { store: Store }) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const s = store.state;
  const orchestrated = s.config?.summary.roles?.some((r) => r.id === "orchestrator" && r.enabled) ?? false;
  const revertId = revertableRunId(s);
  return (
    <div class="app">
      <nav class="tabs">
        <TabButton store={store} view="chat" active={s.view === "chat"}>Chat</TabButton>
        <TabButton store={store} view="settings" active={s.view === "settings"}>Settings</TabButton>
        <span class="spacer" />
        <span class="badge mode">{orchestrated ? "Orchestrated" : "Direct"}</span>
        {s.runProfile && s.runProfile !== "normal" ? <span class="badge profile">{s.runProfile}</span> : null}
        {revertId ? (
          <button class="small deny" onClick={() => store.revert(revertId)}>
            Revert run changes
          </button>
        ) : null}
      </nav>
      {s.view === "chat" ? <ChatView store={store} /> : <SettingsView store={store} />}
    </div>
  );
}

export { fmtElapsed } from "./ChatView.js";
