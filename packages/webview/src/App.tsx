import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./state.js";
import { SettingsView } from "./SettingsView.js";

export function App({ store }: { store: Store }) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const s = store.state;
  return (
    <div class="app">
      <nav class="tabs">
        <button class={s.view === "chat" ? "tab active" : "tab"} onClick={() => store.setView("chat")}>
          Chat
        </button>
        <button class={s.view === "settings" ? "tab active" : "tab"} onClick={() => store.setView("settings")}>
          Settings
        </button>
      </nav>
      {s.view === "chat" ? <ChatView store={store} /> : <SettingsView store={store} />}
    </div>
  );
}

function ChatView({ store }: { store: Store }) {
  const s = store.state;
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView?.({ block: "end" }), [s.items.length, s.items.at(-1)?.text]);
  const send = () => {
    store.send(draft);
    setDraft("");
  };
  return (
    <div class="chat">
      <div class="items">
        {s.items.map((it) => (
          <div key={it.id} class={`item ${it.role}`}>
            {it.reasoning ? <details class="reasoning"><summary>thinking</summary>{it.reasoning}</details> : null}
            <div class="bubble">{it.text || (it.streaming ? "…" : "")}</div>
            {it.activity.length ? (
              <div class="activity">
                {it.activity.map((a, i) => (
                  <div key={i} class={`act ${a.kind}`}>
                    {a.kind.startsWith("tool") ? "⚙ " : ""}
                    {a.text}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {s.approvals.map((a) => (
          <div key={a.approvalId} class="card approval">
            <div class="card-title">
              Approve <b>{a.tool}</b> <span class="cat">[{a.category}]</span>
            </div>
            <pre class="args">{JSON.stringify(a.args, null, 2)}</pre>
            <div class="row">
              <button onClick={() => store.approve(a.approvalId, "once")}>Once</button>
              <button onClick={() => store.approve(a.approvalId, "chat")}>This chat</button>
              <button onClick={() => store.approve(a.approvalId, "always")}>Always</button>
              <button class="deny" onClick={() => store.approve(a.approvalId, "deny")}>
                Deny
              </button>
            </div>
          </div>
        ))}
        {s.questions.map((q) => (
          <QuestionCard key={q.questionId} q={q} onAnswer={(a) => store.answer(q.questionId, a)} />
        ))}
        <div ref={endRef} />
      </div>
      <div class="composer">
        <textarea
          value={draft}
          placeholder={s.busyRunId ? "Waiting for reply…" : "Ask Stewart"}
          disabled={!!s.busyRunId}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {s.busyRunId ? (
          <button class="stop" onClick={() => store.cancel()}>
            Stop
          </button>
        ) : (
          <button class="send" disabled={!draft.trim()} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionCard({ q, onAnswer }: { q: { questionId: string; question: string; options?: string[] }; onAnswer(a: string): void }) {
  const [free, setFree] = useState("");
  return (
    <div class="card question">
      <div class="card-title">{q.question}</div>
      {q.options?.length ? (
        <div class="row">
          {q.options.map((o) => (
            <button key={o} onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : (
        <div class="row">
          <input value={free} onInput={(e) => setFree((e.target as HTMLInputElement).value)} />
          <button disabled={!free.trim()} onClick={() => onAnswer(free)}>
            Reply
          </button>
        </div>
      )}
    </div>
  );
}
