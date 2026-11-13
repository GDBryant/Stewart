import type { ChatItem, PendingApproval, Store } from "./state.js";

export function MessageItem({ item, onRevertTurn }: { item: ChatItem; onRevertTurn?: () => void }) {
  return (
    <div class={`item ${item.role}`}>
      {item.reasoning ? <details class="reasoning"><summary>thinking</summary>{item.reasoning}</details> : null}
      <div class="bubble">
        {item.revertTurn ? (
          <button class="small" onClick={onRevertTurn}>
            Revert this turn
          </button>
        ) : null}
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
