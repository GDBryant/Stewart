import { useEffect, useState } from "preact/hooks";
import type { ActivityEntry, ChatItem, PendingApproval, Store } from "./state.js";
import { renderMarkdown } from "./markdown.js";

const ICONS: [string, string][] = [
  ["read", "📖"],
  ["search", "🔍"],
  ["glob", "🔍"],
  ["grep", "🔍"],
  ["list", "📂"],
  ["ls", "📂"],
  ["write", "✎"],
  ["edit", "✎"],
  ["create", "✎"],
  ["patch", "✎"],
  ["terminal", "⌨"],
  ["command", "⌨"],
  ["exec", "⌨"],
];

/** A per-tool glyph for a step; falls back to a gear for any other tool. */
export function activityIcon(a: ActivityEntry): string {
  if (a.kind === "tool-ok" && !a.tool) return "✅";
  if (a.kind === "tool-fail") return "❌";
  if (a.kind === "escalated") return "⤴";
  const t = (a.tool ?? a.text ?? "").toLowerCase();
  const hit = ICONS.find(([k]) => t.includes(k));
  return hit ? hit[1] : "⚙";
}

function roleLabel(role: ChatItem["role"]) {
  return role === "user" ? "user" : role === "assistant" ? "Stewart (agent)" : null;
}

function bubbleBody(item: ChatItem) {
  return item.role === "assistant"
    ? item.text
      ? renderMarkdown(item.text)
      : item.streaming
        ? "…"
        : null
    : item.text || (item.streaming ? "…" : "");
}

function imagesBlock(images: string[]) {
  return (
    <div class="msg-images">
      {images.map((src, i) => <img key={i} src={src} alt={`image-${i + 1}`} />)}
    </div>
  );
}

function filesChangedBlock(files: string[]) {
  return (
    <div class="files-changed">
      <div class="files-title">Files changed</div>
      {files.map((f) => (
        <div key={f} class="file-row">
          <span class="file-ico">📄</span>
          <span class="file-name">{f}</span>
        </div>
      ))}
    </div>
  );
}

export function MessageItem({ item, onRevertTurn }: { item: ChatItem; onRevertTurn?: () => void }) {
  return (
    <div class={`item ${item.role}`}>
      <div class={`role-label ${item.role}`}>{roleLabel(item.role)}</div>
      {item.reasoning ? <details class="reasoning"><summary>thinking</summary>{item.reasoning}</details> : null}
      {item.activity.length ? <StepsBlock item={item} /> : null}
      <div class={`bubble${item.role === "assistant" ? " bubble-md" : ""}`}>
        {item.revertTurn ? (
          <button class="small" onClick={onRevertTurn}>
            Revert this turn
          </button>
        ) : null}
        {item.images?.length ? imagesBlock(item.images) : null}
        {bubbleBody(item)}
      </div>
      {item.filesChanged?.length ? filesChangedBlock(item.filesChanged) : null}
    </div>
  );
}

/**
 * The collapsible step list. Open by default while the run is streaming (so the user
 * follows progress), auto-collapsed once it finishes; a manual toggle is sticky.
 * A plain button drives open/close (no <details> native toggle to fight React).
 */
function StepsBlock({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(!!item.streaming);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    setOpen(!!item.streaming);
  }, [item.streaming, touched]);
  const n = item.activity.length;
  return (
    <div class="steps">
      <button class="steps-head" aria-expanded={open} onClick={() => { setTouched(true); setOpen(!open); }}>
        <span class={`steps-caret${open ? "" : " closed"}`}>▸</span>
        <span class="steps-title">{n} {n === 1 ? "step" : "steps"}</span>
      </button>
      {open ? (
        <div class="steps-list">
          {item.activity.map((a, i) => (
            <div key={i} class={`act ${a.kind}`}>
              <span class="act-ico">{activityIcon(a)}</span>
              <span class="act-text">{a.text ?? ""}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalCard({ approval, onApprove }: { approval: PendingApproval; onApprove: Store["approve"] }) {
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

