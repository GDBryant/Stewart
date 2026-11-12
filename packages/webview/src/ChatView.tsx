import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./state.js";
import { Composer } from "./Composer.js";
import { MessageItem, ApprovalCard } from "./MessageItem.js";

export function ChatView({ store }: { store: Store }) {
  const s = store.state;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView?.({ block: "end" }), [s.items.length, s.items.at(-1)?.text]);
  const approve: Store["approve"] = (approvalId, grant) => store.approve(approvalId, grant);
  return (
    <div class="chat">
      <div class="chat-bar">
        <button class="small" onClick={() => store.newSession()}>New chat</button>
        <button class="small" onClick={() => store.toggleHistory()}>History</button>
        {s.sessionId ? <span class="badge">{s.sessionId}</span> : null}
      </div>
      {s.historyOpen ? <HistoryPanel store={store} /> : null}
      <div class="items">
        {s.items.map((it) => (
          <MessageItem key={it.id} item={it} />
        ))}
        {s.tasks.some((t) => t.status === "running") ? <ActiveTasks tasks={s.tasks} /> : null}
        {s.tasks.length ? <TaskCard tasks={s.tasks} /> : null}
        {s.cost ? <CostCard cost={s.cost} /> : null}
        {s.approvals.map((a) => (
          <ApprovalCard key={a.approvalId} approval={a} onApprove={approve} />
        ))}
        {s.questions.map((q) => (
          <QuestionCard key={q.questionId} q={q} onAnswer={(a) => store.answer(q.questionId, a)} />
        ))}
        <div ref={endRef} />
      </div>
      <Composer store={store} />
    </div>
  );
}

function HistoryPanel({ store }: { store: Store }) {
  const s = store.state;
  return (
    <div class="card history">
      <div class="card-title">Sessions</div>
      {s.sessions.length ? (
        s.sessions.map((sess) => (
          <div key={sess.sessionId} class={`session-row ${sess.sessionId === s.sessionId ? "active" : ""}`}>
            <button class="session-open" onClick={() => store.openSession(sess.sessionId)} title={sess.sessionId}>
              {sess.title || sess.sessionId}
            </button>
            <span class="session-meta">
              {new Date(sess.savedAt).toLocaleString()} · {sess.messageCount} msg
            </span>
            <button class="small deny" onClick={() => store.deleteSession(sess.sessionId)}>Delete</button>
          </div>
        ))
      ) : (
        <p class="hint">No saved sessions.</p>
      )}
    </div>
  );
}

export function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}

function ActiveTasks({ tasks }: { tasks: { taskId: string; roleId: string; agentId?: string; title: string; status: string; startedAt?: number }[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="card active-tasks">
      <div class="card-title">
        Active
      </div>
      {tasks
        .filter((t) => t.status === "running")
        .map((t) => (
          <div key={t.taskId} class="active-task">
            <span class="task-role">{t.roleId}</span>
            <span class="task-agent">{t.agentId ?? ""}</span>
            <span class="task-title">{t.title}</span>
            <span class="task-timer">{fmtElapsed(now - (t.startedAt ?? now))}</span>
          </div>
        ))}
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
