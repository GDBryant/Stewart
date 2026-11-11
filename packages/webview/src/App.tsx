import { useEffect, useState } from "preact/hooks";
import type { Store } from "./state.js";
import { ChatView } from "./ChatView.js";
import { SettingsView } from "./SettingsView.js";

export function App({ store }: { store: Store }) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const s = store.state;
  const orchestrated = s.config?.summary.roles?.some((r) => r.id === "orchestrator" && r.enabled) ?? false;
  return (
    <div class="app">
      <nav class="tabs">
        <button class={s.view === "chat" ? "tab active" : "tab"} onClick={() => store.setView("chat")}>
          Chat
        </button>
        <button class={s.view === "settings" ? "tab active" : "tab"} onClick={() => store.setView("settings")}>
          Settings
        </button>
        <span class="spacer" />
        <span class="badge mode">{orchestrated ? "Orchestrated" : "Direct"}</span>
        {s.runProfile && s.runProfile !== "normal" ? <span class="badge profile">{s.runProfile}</span> : null}
        {s.lastRunId && !s.busyRunId && !s.revertedRuns.includes(s.lastRunId) ? (
          <button class="small deny" onClick={() => store.revert(s.lastRunId)}>
            Revert run changes
          </button>
        ) : null}
      </nav>
      {s.view === "chat" ? <ChatView store={store} /> : <SettingsView store={store} />}
    </div>
  );
}

export { fmtElapsed } from "./ChatView.js";
