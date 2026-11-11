import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SetupDraft, SetupSessionDeps } from "./sessionTypes.js";

/** A channel the wizard adds during setup (the subset of a channel definition the wizard knows about). */
export interface DraftChannelInput {
  id: string;
  type: string;
  baseUrl?: string;
  /** Secret reference; defaults to `channel-<id>` when an API key is supplied. */
  secretRef?: string;
  enabled?: boolean;
}

export type DraftChannelResult = { ok: true } | { ok: false; error: string };

type Item = Record<string, unknown>;
const FILE = "channels.yaml";
const fail = (error: string): DraftChannelResult => ({ ok: false, error });
const render = (items: Item[]): string => stringifyYaml({ version: 1, items }, null, 2);

function parseItems(text: string | undefined): Item[] | undefined {
  if (!text?.trim()) return [];
  try {
    const doc = parseYaml(text) as { items?: unknown } | null;
    return Array.isArray(doc?.items) ? (doc.items as Item[]).filter((i) => i && typeof i === "object") : [];
  } catch {
    return undefined;
  }
}

type Deps = Pick<SetupSessionDeps, "readUserFiles" | "writeUserFile" | "setSecret" | "deleteSecret" | "deleteUserFile" | "existingChannelIds">;

/**
 * Write a channel to channels.yaml ahead of approval so probes and tests can use it, and record it in the draft:
 * the first write captures the original file (`channelsBase`) so cancel can roll back and undo can restore it.
 * A channel added by this session can be re-added (replaced); an id that already exists elsewhere is refused.
 */
export async function addDraftChannel(deps: Deps, draft: SetupDraft, input: DraftChannelInput, apiKey?: string): Promise<DraftChannelResult> {
  const id = input.id?.trim();
  const type = input.type?.trim();
  if (!id) return fail("channel id is required");
  if (!type) return fail("channel type is required");
  const current = (await deps.readUserFiles())[FILE];
  const items = parseItems(current);
  if (!items) return fail("channels.yaml is not valid YAML; fix it in Settings first");
  if (isRefusedId(deps, draft, items, id)) return fail(`channel '${id}' already exists`);
  if (apiKey && !deps.setSecret) return fail("secret storage is unavailable");

  captureBase(draft, current);
  const secretRef = secretRefFor(id, input, apiKey);
  await stageSecret(deps, draft, secretRef, apiKey);
  await deps.writeUserFile(FILE, render([...items.filter((i) => i.id !== id), buildItem(id, type, input, secretRef)]));
  if (!draft.addedChannels.includes(id)) draft.addedChannels.push(id);
  return { ok: true };
}

/** True when the id exists in channels.yaml or elsewhere, and this session did not add it (re-adding its own channel is allowed). */
function isRefusedId(deps: Deps, draft: SetupDraft, items: Item[], id: string): boolean {
  const taken = items.some((i) => i.id === id) || (deps.existingChannelIds?.() ?? []).includes(id);
  return taken && !draft.addedChannels.includes(id);
}

function captureBase(draft: SetupDraft, current: string | undefined): void {
  if (draft.channelsBase === undefined) draft.channelsBase = current ?? null;
}

function secretRefFor(id: string, input: DraftChannelInput, apiKey: string | undefined): string | undefined {
  return apiKey ? (input.secretRef ?? `channel-${id}`) : input.secretRef;
}

async function stageSecret(deps: Deps, draft: SetupDraft, ref: string | undefined, apiKey: string | undefined): Promise<void> {
  if (!apiKey || !ref) return;
  if (!draft.secretsCreated.includes(ref)) draft.secretsCreated.push(ref);
  await deps.setSecret!(ref, apiKey);
}

function buildItem(id: string, type: string, input: DraftChannelInput, secretRef: string | undefined): Item {
  return { id, type, enabled: input.enabled ?? true, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(secretRef ? { secretRef } : {}) };
}

/** Remove a channel this session added (and its secret); other channels are never touched. */
export async function removeDraftChannel(deps: Deps, draft: SetupDraft, id: string): Promise<DraftChannelResult> {
  if (!draft.addedChannels.includes(id)) return fail(`channel '${id}' was not added by this setup session`);
  const items = parseItems((await deps.readUserFiles())[FILE]) ?? [];
  const gone = items.find((i) => i.id === id);
  await deps.writeUserFile(FILE, render(items.filter((i) => i.id !== id)));
  draft.addedChannels = draft.addedChannels.filter((c) => c !== id);
  draft.channels = draft.channels.filter((c) => c.id !== id);
  const ref = typeof gone?.secretRef === "string" ? gone.secretRef : undefined;
  if (ref && draft.secretsCreated.includes(ref)) {
    draft.secretsCreated = draft.secretsCreated.filter((r) => r !== ref);
    await deps.deleteSecret?.(ref);
  }
  return { ok: true };
}

/** Undo every channel write: restore channels.yaml to its pre-session content (delete it if it did not exist). */
export async function rollbackDraftChannels(deps: Deps, draft: SetupDraft): Promise<void> {
  if (draft.channelsBase === undefined) return;
  const base = draft.channelsBase;
  if (base !== null) await deps.writeUserFile(FILE, base).catch(() => {});
  else if (deps.deleteUserFile) await deps.deleteUserFile(FILE).catch(() => {});
  else await deps.writeUserFile(FILE, render([])).catch(() => {});
}

/** The user files as they were before this session wrote any channel (what a backup must hold so undo removes the channels). */
export function backupBase(draft: SetupDraft, current: Record<string, string | undefined>): Record<string, string | undefined> {
  return draft.channelsBase === undefined ? current : { ...current, [FILE]: draft.channelsBase ?? undefined };
}

/** The staged file set plus channels.yaml when this session added channels, so review shows and validation covers it. */
export function composeFiles(draft: SetupDraft, current: Record<string, string | undefined>): Record<string, string> {
  const files = { ...(draft.files ?? {}) };
  if (draft.addedChannels.length > 0 && current[FILE] !== undefined) files[FILE] = current[FILE]!;
  return files;
}
