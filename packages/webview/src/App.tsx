import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { State, Store } from "./state.js";
import { ChatView } from "./ChatView.js";
import { SettingsView } from "./SettingsView.js";

function TabButton({ store, view, active, children }: { store: Store; view: State["view"]; active: boolean; children: ComponentChildren }) {
  return <button class={active ? "tab active" : "tab"} onClick={() => store.setView(view)}>{children}</button>;
}

export function App({ store }: { store: Store }) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const s = store.state;
  return (
    <div class="app">
      <nav class="tabs">
        <TabButton store={store} view="chat" active={s.view === "chat"}>Chat</TabButton>
        <TabButton store={store} view="settings" active={s.view === "settings"}>Settings</TabButton>
        <span class="spacer" />
      </nav>
      {s.view === "chat" ? <ChatView store={store} /> : <SettingsView store={store} />}
    </div>
  );
}

export { fmtElapsed } from "./ChatView.js";
