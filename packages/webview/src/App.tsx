import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./state.js";
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
        {s.plan ? <PlanCard plan={s.plan} /> : null}
        {s.tasks.length ? <TaskCard tasks={s.tasks} /> : null}
        {s.cost ? <CostCard cost={s.cost} /> : null}
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

function PlanCard({ plan }: { plan: { milestoneCount: number; verdict?: "approve" | "revise"; reasons: string[]; approved: boolean } }) {
  return (
    <div class="card plan">
      <div class="card-title">
        Plan <span class="badge">{plan.milestoneCount} milestone(s)</span>
        {plan.approved ? <span class="badge ok">approved</span> : plan.verdict === "revise" ? <span class="badge warn">revise</span> : null}
      </div>
      {plan.reasons.length ? <ul class="reasons">{plan.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
    </div>
  );
}

function TaskCard({ tasks }: { tasks: { taskId: string; roleId: string; title: string; status: string; summary?: string; waitingOn?: string }[] }) {
  return (
    <div class="card tasks">
      <div class="card-title">Tasks</div>
      {tasks.map((t) => (
        <div key={t.taskId} class={`task ${t.status}`}>
          <span class="task-role">{t.roleId}</span>
          <span class="task-title">{t.title}</span>
          <span class="task-status">{t.status === "waiting" && t.waitingOn ? `waiting for ${t.waitingOn}` : t.status}</span>
          {t.summary && t.status !== "done" ? <div class="task-summary">{t.summary}</div> : null}
        </div>
      ))}
    </div>
  );
}

function CostCard({ cost }: { cost: { capUsd: number; accruedUsd: number; overshootUsd: number; byRole: Record<string, number>; parked: string[]; freeFinished: string[]; suggestions: { role: string; agent: string; reason: string }[] } }) {
  return (
    <div class="card cost">
      <div class="card-title">
        Cost <span class="badge">${cost.accruedUsd.toFixed(2)} of ${cost.capUsd.toFixed(2)}</span>
        {cost.overshootUsd > 0 ? <span class="badge warn">overshoot ${cost.overshootUsd.toFixed(2)}</span> : null}
      </div>
      {Object.entries(cost.byRole).map(([role, usd]) => (
        <div key={role} class="cost-row">
          <span class="cost-role">{role}</span>
          <span class="cost-usd">${usd.toFixed(2)}</span>
        </div>
      ))}
      {cost.parked.length ? <div class="cost-note">parked: {cost.parked.join(", ")}</div> : null}
      {cost.freeFinished.length ? <div class="cost-note">finished free: {cost.freeFinished.join(", ")}</div> : null}
      {cost.suggestions.map((s) => (
        <div key={`${s.role}-${s.agent}`} class="cost-note">
          suggest {s.role} → {s.agent} ({s.reason})
        </div>
      ))}
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
