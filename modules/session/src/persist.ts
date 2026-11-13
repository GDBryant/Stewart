import type { ChatMessage, HostPort } from "@stewart/kernel";
import { changeTracker } from "@stewart/tasks";
import { ProjectPaths } from "@stewart/tools";
import type { ChatHistoryStore } from "./history.js";
import { err } from "./turnState.js";

/** Persisted engine blob for one session; corrupt state starts fresh. */
export async function loadEngineState(host: HostPort, stateDir: string, sessionId: string): Promise<Record<string, unknown>> {
  const path = `${stateDir}/sessions/${sessionId}.engine.json`;
  try {
    if (await host.files.exists(path)) return JSON.parse((await host.files.read(path)).content) as Record<string, unknown>;
  } catch {
    /* corrupt engine state starts fresh */
  }
  return {};
}

/** Transcript + engine state; failures log and never fail the run. */
export async function persistTurn(host: HostPort, w: { sessionId: string; stateDir: string; store: ChatHistoryStore; transcript: ChatMessage[]; state: Record<string, unknown> }): Promise<void> {
  try {
    await w.store.save(w.sessionId, w.transcript);
  } catch (e) {
    host.log(`history save failed: ${err(e)}`);
  }
  try {
    await host.files.writeAtomic(`${w.stateDir}/sessions/${w.sessionId}.engine.json`, JSON.stringify(w.state));
  } catch (e) {
    host.log(`engine state save failed: ${err(e)}`);
  }
}

/** Session deletion (history retention or explicit): tracker state plus every session-owned file. */
export async function dropSessionArtifacts(host: HostPort, sessionId: string): Promise<void> {
  const stateDir = await host.workspace.stateDir();
  const paths = await ProjectPaths.forProject(host);
  try {
    await changeTracker(host, { cwd: paths.base, stateDir, sessionId }).dispose();
  } catch (e) {
    host.log(`tracker dispose failed for session ${sessionId}: ${err(e)}`);
  }
  for (const ext of ["engine.json", "turn", "plan", "archive.jsonl"]) await host.files.delete(`${stateDir}/sessions/${sessionId}.${ext}`).catch(() => {});
  for (const name of await host.files.list(`${stateDir}/sessions/${sessionId}`).catch(() => [] as string[])) await host.files.delete(name).catch(() => {});
  await host.files.delete(`${paths.base}/.stewart/plans/${sessionId}.md`).catch(() => {});
}
