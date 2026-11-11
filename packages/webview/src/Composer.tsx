import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./state.js";

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

export function Composer({ store }: { store: Store }) {
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
