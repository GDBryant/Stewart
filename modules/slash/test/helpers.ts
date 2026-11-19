import { counterIds, fakeHost, systemClock } from "@stewart/kernel";
import { Interaction } from "@stewart/interaction";
import type { RunEvent } from "@stewart/protocol";
import { createSlashRegistry } from "../src/api.js";

export const REGISTRY = createSlashRegistry();

export function makeDeps(files: Record<string, string> = {}) {
  const events: RunEvent[] = [];
  const { host } = fakeHost(files);
  const interaction = new Interaction({ ids: counterIds(), clock: systemClock, bus: { emit: (e) => events.push(e) } });
  const sent: { sessionId?: string; text: string }[] = [];
  const cleared: string[] = [];
  const deps = {
    ids: counterIds(),
    emit: (e: RunEvent) => events.push(e),
    files: host.files,
    interaction,
    session: {
      send: async (sessionId: string | undefined, text: string) => {
        sent.push({ sessionId, text });
      },
      clear: async (sessionId: string) => {
        cleared.push(sessionId ?? "");
        return { ok: true };
      },
    },
  };
  return { deps, events, interaction, sent, cleared, files };
}

export const locals = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { kind: "chat.local" }> => e.kind === "chat.local").map((e) => e.text);

export const questions = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { kind: "ask_user" }> => e.kind === "ask_user");
