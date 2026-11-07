import { createHash } from "node:crypto";
import type { HostPort } from "@stewart/kernel";
import type { ChatMessage } from "@stewart/kernel";
import { mediaTypeFor } from "./images.js";

export interface StoredImage {
  file: string;
  mediaType: string;
  name: string;
}

export interface StoredMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  images?: StoredImage[];
}

export interface StoredChat {
  version: number;
  sessionId: string;
  title: string;
  savedAt: number;
  messages: StoredMessage[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  savedAt: number;
  messageCount: number;
}

const VERSION = 1;
const SAFE_IMAGE = /^[a-f0-9]{64}\.[a-z]+$/;

function extFor(mediaType: string): string {
  return mediaType.split("/")[1] ?? "bin";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Per-project chat sessions under `<stateDir>/history/`. Writes are atomic;
 * an unreadable session is quarantined as `.corrupt`. Images live in a
 * hash-deduped sibling folder; unreferenced files are swept on save.
 */
export class ChatHistoryStore {
  constructor(
    private host: Pick<HostPort, "files">,
    private dir: string,
    private retentionDays = 30,
  ) {}

  private file(sessionId: string): string {
    return `${this.dir}/${sessionId}.json`;
  }

  private imagesDir(sessionId: string): string {
    return `${this.dir}/${sessionId}-images`;
  }

  async save(sessionId: string, messages: ChatMessage[], savedAt = Date.now()): Promise<void> {
    const stored: StoredMessage[] = [];
    const keep = new Set<string>();
    for (const m of messages) {
      if (m.role === "system") continue;
      const msg: StoredMessage = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.toolCalls?.length) msg.toolCalls = m.toolCalls;
      if (m.role === "tool") msg.toolCallId = m.toolCallId;
      if (m.role === "user" && m.images?.length) {
        msg.images = [];
        for (let i = 0; i < m.images.length; i++) {
          const parsed = /^data:([^;]+);base64,(.*)$/s.exec(m.images[i]);
          const mediaType = parsed?.[1] ?? "image/png";
          const b64 = parsed?.[2] ?? m.images[i];
          const hash = await sha256Hex(b64ToBytes(b64));
          const file = `${hash}.${extFor(mediaType)}`;
          keep.add(file);
          if (!(await this.host.files.exists(`${this.imagesDir(sessionId)}/${file}`))) {
            await this.host.files.writeBinary(`${this.imagesDir(sessionId)}/${file}`, b64);
          }
          msg.images.push({ file, mediaType, name: `image-${i + 1}` });
        }
      }
      stored.push(msg);
    }
    const firstUser = stored.find((m) => m.role === "user");
    const title = (firstUser?.content ?? "chat").slice(0, 60);
    const chat: StoredChat = { version: VERSION, sessionId, title, savedAt, messages: stored };
    await this.host.files.writeAtomic(this.file(sessionId), JSON.stringify(chat));
    await this.sweepImages(sessionId, keep);
  }

  private async sweepImages(sessionId: string, keep: Set<string>): Promise<void> {
    const dir = this.imagesDir(sessionId);
    if (!(await this.host.files.exists(dir))) return;
    for (const name of await this.host.files.list(dir)) {
      const base = name.split("/").pop() ?? name;
      if (!keep.has(base)) await this.host.files.delete(`${dir}/${base}`);
    }
  }

  async load(sessionId: string): Promise<ChatMessage[] | null> {
    const path = this.file(sessionId);
    if (!(await this.host.files.exists(path))) return null;
    let chat: StoredChat;
    try {
      chat = JSON.parse((await this.host.files.read(path)).content) as StoredChat;
      if (chat.version !== VERSION || !Array.isArray(chat.messages)) throw new Error("bad version");
    } catch {
      await this.quarantine(path);
      return null;
    }
    const out: ChatMessage[] = [];
    for (const m of chat.messages) {
      if (m.role === "tool") {
        out.push({ role: "tool", toolCallId: m.toolCallId ?? "", content: m.content });
        continue;
      }
      const images: string[] = [];
      for (const img of m.images ?? []) {
        if (!SAFE_IMAGE.test(img.file)) continue;
        try {
          const { base64 } = await this.host.files.readBinary(`${this.imagesDir(sessionId)}/${img.file}`);
          images.push(`data:${img.mediaType};base64,${base64}`);
        } catch {
          /* missing image file: keep the placeholder name */
        }
      }
      if (m.role === "assistant") {
        out.push({ role: "assistant", content: m.content, toolCalls: m.toolCalls });
      } else {
        out.push({ role: m.role, content: m.content, images: images.length ? images : undefined });
      }
    }
    return out;
  }

  private async quarantine(path: string): Promise<void> {
    try {
      const { content } = await this.host.files.read(path);
      await this.host.files.writeAtomic(`${path}.corrupt`, content);
    } catch {
      /* unreadable: still remove it */
    }
    await this.host.files.delete(path);
  }

  async list(): Promise<SessionSummary[]> {
    if (!(await this.host.files.exists(this.dir))) return [];
    const names = await this.host.files.list(this.dir);
    const out: SessionSummary[] = [];
    for (const name of names) {
      const base = name.split("/").pop() ?? name;
      if (!base.endsWith(".json")) continue;
      const full = `${this.dir}/${base}`;
      try {
        const chat = JSON.parse((await this.host.files.read(full)).content) as StoredChat;
        if (chat.version !== VERSION) continue;
        out.push({ sessionId: chat.sessionId, title: chat.title, savedAt: chat.savedAt, messageCount: chat.messages.length });
      } catch {
        await this.quarantine(full);
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(sessionId: string): Promise<void> {
    await this.host.files.delete(this.file(sessionId));
    const dir = this.imagesDir(sessionId);
    if (await this.host.files.exists(dir)) {
      for (const name of await this.host.files.list(dir)) {
        await this.host.files.delete(`${dir}/${name.split("/").pop() ?? name}`);
      }
    }
  }

  /** Drop sessions older than retentionDays (0 = keep forever). Returns removed ids. */
  async prune(now = Date.now()): Promise<string[]> {
    if (this.retentionDays <= 0) return [];
    const cutoff = now - this.retentionDays * 86_400_000;
    const removed: string[] = [];
    for (const s of await this.list()) {
      if (s.savedAt < cutoff) {
        await this.delete(s.sessionId);
        removed.push(s.sessionId);
      }
    }
    return removed;
  }
}

/** Media type a stored image advertises; extension fallback for older files. */
export function storedMediaType(img: StoredImage): string {
  return img.mediaType || mediaTypeFor(img.file) || "image/png";
}

export { bytesToB64 as imgBytesToB64 };
