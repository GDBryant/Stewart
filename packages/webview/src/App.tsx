import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatItem, PendingApproval, Store } from "./state.js";
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

function dataUriFromFile(file: File, done: (uri: string) => void): void {
  const r = new FileReader();
  r.onload = () => done(String(r.result));
  r.readAsDataURL(file);
}

function isImageFile(f: File): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/.test(f.type);
}

function ChatView({ store }: { store: Store }) {
  const s = store.state;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView?.({ block: "end" }), [s.items.length, s.items.at(-1)?.text]);
  const approve: Store["approve"] = (approvalId, grant) => store.approve(approvalId, grant);
  const singleDirect = s.tasks.length === 1 && s.tasks[0]!.taskId === "direct";
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
        {s.plan ? <PlanCard plan={s.plan} /> : null}
        {!singleDirect && s.tasks.some((t) => t.status === "running") ? <ActiveTasks tasks={s.tasks} profile={s.runProfile} /> : null}
        {s.tasks.length && !singleDirect ? <TaskCard tasks={s.tasks} /> : null}
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

function MessageItem({ item }: { item: ChatItem }) {
  return (
    <div class={`item ${item.role}`}>
      {item.reasoning ? <details class="reasoning"><summary>thinking</summary>{item.reasoning}</details> : null}
      <div class="bubble">
        {item.images?.length ? (
          <div class="msg-images">
            {item.images.map((src, i) => <img key={i} src={src} alt={`image-${i + 1}`} />)}
          </div>
        ) : null}
        {item.text || (item.streaming ? "…" : "")}
      </div>
      {item.activity.length ? (
        <div class="activity">
          {item.activity.map((a, i) => (
            <div key={i} class={`act ${a.kind}`}>
              {a.kind.startsWith("tool") ? "⚙ " : ""}
              {a.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalCard({ approval, onApprove }: { approval: PendingApproval; onApprove: Store["approve"] }) {
  return (
    <div class="card approval">
      <div class="card-title">
        Approve <b>{approval.tool}</b> <span class="cat">[{approval.category}]</span>
      </div>
      <pre class="args">{JSON.stringify(approval.args, null, 2)}</pre>
      <div class="row">
        <button onClick={() => onApprove(approval.approvalId, "once")}>Once</button>
        <button onClick={() => onApprove(approval.approvalId, "chat")}>This chat</button>
        <button onClick={() => onApprove(approval.approvalId, "always")}>Always</button>
        <button class="deny" onClick={() => onApprove(approval.approvalId, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

function attachFiles(store: Store, files: Iterable<File>): void {
  for (const f of files) {
    if (!isImageFile(f)) {
      store.rejectAttachment("only PNG, JPEG, GIF and WebP images can be attached");
      continue;
    }
    dataUriFromFile(f, (uri) => store.addImage(uri));
  }
}

function clipboardFiles(dt: DataTransfer | null | undefined): File[] {
  const files: File[] = [];
  for (const it of dt?.items ?? []) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

function useComposerInsert(store: Store, setDraft: (fn: (d: string) => string) => void): void {
  const ins = store.state.composerInsert;
  const insertSeq = useRef(0);
  useEffect(() => {
    if (ins && ins.seq !== insertSeq.current) {
      insertSeq.current = ins.seq;
      setDraft((d) => (d ? `${d}\n${ins.text}` : ins.text));
    }
  }, [ins]);
}

function PendingImages({ images, onRemove }: { images: string[]; onRemove(i: number): void }) {
  if (!images.length) return null;
  return (
    <div class="pending-images">
      {images.map((src, i) => (
        <span key={i} class="pending-img">
          <img src={src} alt={`attach-${i + 1}`} />
          <button class="deny" onClick={() => onRemove(i)}>×</button>
        </span>
      ))}
    </div>
  );
}

function ComposerAction({ busy, canSend, onStop, onSend }: { busy: boolean; canSend: boolean; onStop(): void; onSend(): void }) {
  if (busy) return <button class="stop" onClick={onStop}>Stop</button>;
  return <button class="send" disabled={!canSend} onClick={onSend}>Send</button>;
}

function Composer({ store }: { store: Store }) {
  const s = store.state;
  const [draft, setDraft] = useState("");
  const pickerRef = useRef<HTMLInputElement>(null);
  useComposerInsert(store, setDraft);
  const send = () => {
    store.send(draft);
    setDraft("");
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = clipboardFiles(e.clipboardData);
    if (files.length) attachFiles(store, files);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div
      class="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        attachFiles(store, e.dataTransfer?.files ?? []);
      }}
    >
      <PendingImages images={s.pendingImages} onRemove={(i) => store.removeImage(i)} />
      {s.attachError ? <div class="fail attach-error">{s.attachError}</div> : null}
      <textarea
        value={draft}
        placeholder={s.busyRunId ? "Waiting for reply…" : "Ask Stewart"}
        disabled={!!s.busyRunId}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />
      <input
        ref={pickerRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style="display:none"
        onChange={(e) => {
          attachFiles(store, (e.target as HTMLInputElement).files ?? []);
          (e.target as HTMLInputElement).value = "";
        }}
      />
      <button class="small" title="Attach image" onClick={() => pickerRef.current?.click()}>
        📎
      </button>
      <div class="profile-select" role="group" aria-label="budget profile" title="Budget profile">
        {(["auto", "quick", "normal", "deep"] as const).map((p) => (
          <button
            key={p}
            class={`small profile-opt ${s.profileChoice === p ? "active" : ""}`}
            aria-pressed={s.profileChoice === p}
            onClick={() => store.setProfileChoice(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <ComposerAction busy={!!s.busyRunId} canSend={!!draft.trim() || s.pendingImages.length > 0} onStop={() => store.cancel()} onSend={send} />
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

export function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}

function ActiveTasks({ tasks, profile }: { tasks: { taskId: string; roleId: string; agentId?: string; title: string; status: string; startedAt?: number }[]; profile?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="card active-tasks">
      <div class="card-title">
        Active{profile ? <span class="badge profile"> {profile}</span> : null}
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
