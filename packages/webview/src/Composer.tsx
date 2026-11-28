import { useEffect, useRef, useState } from "preact/hooks";
import type { SlashCommandInfo } from "@stewart/protocol";
import { slashMenuComplete, slashMenuFilter, slashMenuMove, slashMenuOpen } from "./slashMenuModel.js";
import { SlashMenu } from "./SlashMenu.js";
import type { Store } from "./state.js";
import type { OutboxItem } from "./stateTypes.js";

function dataUriFromFile(file: File, done: (uri: string) => void): void {
  const r = new FileReader();
  r.onload = () => done(String(r.result));
  r.readAsDataURL(file);
}

function isImageFile(f: File): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/.test(f.type);
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

const appliedInsertSeq = new WeakMap<Store, number>();

function useComposerInsert(store: Store): void {
  const ins = store.state.composerInsert;
  useEffect(() => {
    if (ins && ins.seq !== appliedInsertSeq.get(store)) {
      appliedInsertSeq.set(store, ins.seq);
      const d = store.state.draft;
      store.setDraft(d ? `${d}\n${ins.text}` : ins.text);
    }
  }, [ins]);
}

interface SlashMenuCtl {
  open: boolean;
  items: SlashCommandInfo[];
  selected: number;
  setSel(i: number): void;
  complete(c: SlashCommandInfo): void;
  dismiss(): void;
}

function useSlashMenu(store: Store): SlashMenuCtl {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const draft = store.state.draft;
  useEffect(() => setSel(0), [draft]);
  const items = slashMenuOpen(draft) && draft !== dismissed ? slashMenuFilter(store.state.slashCommands, draft) : [];
  return {
    open: items.length > 0,
    items,
    selected: Math.min(sel, Math.max(items.length - 1, 0)),
    setSel,
    complete: (c) => {
      store.setDraft(slashMenuComplete(c));
      setDismissed(null);
    },
    dismiss: () => setDismissed(draft),
  };
}

function slashMenuKey(e: KeyboardEvent, m: SlashMenuCtl): boolean {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    m.setSel(slashMenuMove(m.selected, m.items.length, 1));
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    m.setSel(slashMenuMove(m.selected, m.items.length, -1));
    return true;
  }
  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    m.complete(m.items[m.selected]);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    m.dismiss();
    return true;
  }
  return false;
}

function useComposerKeys(store: Store, menu: SlashMenuCtl) {
  const submit = (queue = false) => store.submit(store.state.draft, queue);
  const onKey = (e: KeyboardEvent) => {
    if (menu.open && slashMenuKey(e, menu)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.ctrlKey || e.metaKey);
    }
  };
  return { submit, onKey };
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

function OutboxStrip({ store }: { store: Store }) {
  const items = store.state.outbox;
  if (!items.length) return null;
  const q = store.queue;
  return (
    <div class="outbox" aria-label="Queued follow-ups" aria-live="polite" title="unsent; kept only in this panel">
      {items.map((it: OutboxItem, i: number) => (
        <div key={it.id} class={`outbox-row ${it.status}`}>
          {i === 0 ? <span class="badge">Next</span> : null}
          <span class="outbox-text">
            {it.text}
            {it.images?.length ? ` · ${it.images.length} image${it.images.length === 1 ? "" : "s"}` : ""}
          </span>
          {it.status === "sending" ? <span class="hint">sending…</span> : null}
          {it.status === "failed" ? (
            <>
              <span class="fail outbox-error">{it.error}</span>
              <button class="small" title="Try sending this follow-up again" onClick={() => q.retry(it.id)}>Retry</button>
            </>
          ) : null}
          <button class="small" disabled={it.status === "sending"} title="Move this back into the composer; available when the composer is empty" onClick={() => q.edit(it.id)}>Edit</button>
          <button class="deny" disabled={it.status === "sending"} title="Discard this unsent follow-up" onClick={() => q.remove(it.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const BUSY_HINT = IS_MAC ? "Enter guides · ⌘Enter queues · Shift+Enter newline" : "Enter guides · Ctrl+Enter queues · Shift+Enter newline";

function ComposerAction({ store, canSend, onStop, submit }: { store: Store; canSend: boolean; onStop(): void; submit(queue: boolean): void }) {
  const s = store.state;
  if (s.busyRunId) {
    return (
      <>
        <button class="send" aria-keyshortcuts="Enter" title="Send guidance into the active run (Enter)" disabled={!canSend || !!s.steerPending} onClick={() => submit(false)}>Guide</button>
        <button class="small" aria-keyshortcuts="Control+Enter Meta+Enter" title={IS_MAC ? "Queue as a follow-up (⌘Enter)" : "Queue as a follow-up (Ctrl+Enter)"} disabled={!canSend || s.outbox.length >= 20} onClick={() => submit(true)}>Queue</button>
        <button class="stop" onClick={onStop}>Stop</button>
      </>
    );
  }
  const queued = !!s.outboxSending || s.outbox.length > 0;
  return (
    <button class="send" disabled={!canSend} title={queued ? "Add to the queued follow-ups" : undefined} onClick={() => submit(queued)}>
      {queued ? "Queue" : "Send"}
    </button>
  );
}

function ComposerTextarea({ draft, busy, onDraft, onAttach, onKey, onBlur }: {
  draft: string;
  busy: boolean;
  onDraft(text: string): void;
  onAttach(files: File[]): void;
  onKey(e: KeyboardEvent): void;
  onBlur(): void;
}) {
  const onPaste = (e: ClipboardEvent) => {
    const files = clipboardFiles(e.clipboardData);
    if (files.length) onAttach(files);
  };
  return (
    <textarea
      value={draft}
      placeholder={busy ? "Guide this run…" : "Ask Stewart"}
      aria-describedby={busy ? "composer-hint" : undefined}
      onInput={(e) => onDraft((e.target as HTMLTextAreaElement).value)}
      onPaste={onPaste}
      onKeyDown={onKey}
      onBlur={onBlur}
    />
  );
}

function AttachButton({ onFiles }: { onFiles(files: FileList | File[]): void }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={pickerRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style="display:none"
        onChange={(e) => {
          onFiles((e.target as HTMLInputElement).files ?? []);
          (e.target as HTMLInputElement).value = "";
        }}
      />
      <button class="small" title="Attach image" onClick={() => pickerRef.current?.click()}>
        📎
      </button>
    </>
  );
}

export function Composer({ store }: { store: Store }) {
  const s = store.state;
  useComposerInsert(store);
  const menu = useSlashMenu(store);
  const { submit, onKey } = useComposerKeys(store, menu);
  const attach = (files: FileList | File[]) => attachFiles(store, files);
  const busy = !!s.busyRunId;
  return (
    <div class="composer-wrap">
      {menu.open ? <SlashMenu items={menu.items} selected={menu.selected} onPick={menu.complete} /> : null}
      <OutboxStrip store={store} />
      {busy ? <div class="composer-hint" id="composer-hint">{BUSY_HINT}</div> : null}
      {s.steerWarning ? <div class="fail composer-warning">{s.steerWarning}</div> : null}
      <div
        class="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          attach(e.dataTransfer?.files ?? []);
        }}
      >
        <PendingImages images={s.pendingImages} onRemove={(i) => store.removeImage(i)} />
        {s.attachError ? <div class="fail attach-error">{s.attachError}</div> : null}
        <ComposerTextarea draft={s.draft} busy={busy} onDraft={(t) => store.setDraft(t)} onAttach={attach} onKey={onKey} onBlur={menu.dismiss} />
        <AttachButton onFiles={attach} />
        <ComposerAction store={store} canSend={!!s.draft.trim() || s.pendingImages.length > 0} onStop={() => store.cancel()} submit={submit} />
      </div>
    </div>
  );
}
