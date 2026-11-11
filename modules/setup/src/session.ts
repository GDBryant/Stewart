import { createHash } from "node:crypto";
import { SETUP_FILES, type Evaluation, type SetupDraft, type SetupEvent, type SetupPhase, type SetupSessionDeps } from "./sessionTypes.js";
import { backupSetupFiles, restoreSetupFiles, writeSetupFiles } from "./sessionFiles.js";
import { addDraftChannel, backupBase, composeFiles, removeDraftChannel, rollbackDraftChannels, type DraftChannelInput, type DraftChannelResult } from "./draftChannels.js";

export { SETUP_FILES };
export type { Evaluation, SetupDraft, SetupEvent, SetupPhase, SetupSessionDeps };

const PHASES: readonly SetupPhase[] = ["channels", "evaluator", "evaluate", "assign", "approve", "saved"] as const;
const DRAFT_VERSION = 1;
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

const PHASE_GATES: Partial<Record<SetupPhase, (d: SetupDraft) => string | undefined>> = {
  channels: (d) => {
    const ok = d.channels.some((c) => c.tested === "ok" && (c.models?.length ?? 0) > 0) || d.reusedChannels.length > 0;
    return ok ? undefined : "need at least one channel tested OK with at least one model";
  },
  evaluator: (d) => (d.evaluator ? undefined : "choose an evaluator or rules only"),
  evaluate: (d) => (d.evaluation?.finished ? undefined : "evaluation has not finished"),
  assign: (d) => (d.assignment !== undefined && d.assignmentValid !== false ? undefined : "assignment is missing or invalid"),
  approve: () => "use review() then approveAndSave(token)",
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function freshDraft(now: number): SetupDraft {
  return { version: DRAFT_VERSION, createdAt: now, phase: "channels", secretsCreated: [], channels: [], reusedChannels: [], addedChannels: [] };
}

export class SetupSession {
  private progressPending: SetupEvent | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private lastProgressAt = 0;
  private readonly now: () => number;

  private constructor(
    private readonly deps: SetupSessionDeps,
    private draft: SetupDraft,
  ) {
    this.now = deps.now ?? Date.now;
  }

  static async open(deps: SetupSessionDeps): Promise<SetupSession> {
    const now = (deps.now ?? Date.now)();
    const path = `${deps.stateDir}/setup-draft.json`;
    try {
      const { content } = await deps.files.read(path);
      const d = JSON.parse(content) as SetupDraft;
      if (d.version === DRAFT_VERSION && typeof d.phase === "string" && now - d.createdAt < DRAFT_TTL_MS) {
        return new SetupSession(deps, { ...d, addedChannels: d.addedChannels ?? [] });
      }
    } catch {
      /* missing or corrupt draft starts fresh */
    }
    return new SetupSession(deps, freshDraft(now));
  }

  get phase(): SetupPhase {
    return this.draft.phase;
  }
  get state(): SetupDraft {
    return { ...this.draft, secretsCreated: [...this.draft.secretsCreated] };
  }

  private get draftPath(): string {
    return `${this.deps.stateDir}/setup-draft.json`;
  }
  private async persist(): Promise<void> {
    await this.deps.files.writeAtomic(this.draftPath, JSON.stringify(this.draft, null, 2));
  }
  private emit(ev: SetupEvent): void {
    this.deps.onEvent?.(ev);
  }
  private emitProgress(): void {
    const ev = this.draft.evaluation;
    if (!ev) return;
    const out: SetupEvent = { kind: "progress", done: ev.done, total: ev.total, running: [], tally: { ...ev.tally } };
    const elapsed = this.now() - this.lastProgressAt;
    if (elapsed >= 100) {
      this.lastProgressAt = this.now();
      this.emit(out);
      return;
    }
    this.progressPending = out;
    if (!this.progressTimer) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined;
        if (this.progressPending) {
          this.lastProgressAt = this.now();
          this.emit(this.progressPending);
          this.progressPending = undefined;
        }
      }, 100 - elapsed);
    }
  }
  private flushProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    if (this.progressPending) {
      this.emit(this.progressPending);
      this.progressPending = undefined;
    }
  }

  /** Merge caller-supplied fields into the draft and persist (channel staging, evaluator pick, candidates, assignment, rendered files). */
  async update(patch: Partial<SetupDraft>): Promise<SetupDraft> {
    const staleEval =
      this.draft.evaluation &&
      (("candidates" in patch && JSON.stringify(patch.candidates) !== JSON.stringify(this.draft.candidates)) ||
        ("evaluator" in patch && JSON.stringify(patch.evaluator) !== JSON.stringify(this.draft.evaluator)));
    Object.assign(this.draft, patch);
    if (staleEval && this.draft.evaluation) this.draft.evaluation.stale = true;
    if (patch.secretsCreated) this.draft.secretsCreated = [...patch.secretsCreated];
    await this.persist();
    return this.state;
  }

  /** Gate to leave the current phase; returns the failure reason or undefined when it passes. */
  gateError(): string | undefined {
    const gate = PHASE_GATES[this.draft.phase];
    return gate ? gate(this.draft) : "session is finished";
  }

  async advance(): Promise<{ ok: boolean; error?: string }> {
    const g = this.gateError();
    if (g) return { ok: false, error: g };
    const next = PHASES[PHASES.indexOf(this.draft.phase) + 1];
    this.draft.phase = next;
    await this.persist();
    this.emit({ kind: "phase", phase: next });
    return { ok: true };
  }

  /** Backward moves are free; earlier results are kept (evaluation marks itself stale on relevant edits). */
  async back(): Promise<{ ok: boolean }> {
    const idx = PHASES.indexOf(this.draft.phase);
    if (idx <= 0 || this.draft.phase === "saved" || this.draft.phase === "cancelled") return { ok: false };
    this.draft.phase = PHASES[idx - 1];
    await this.persist();
    this.emit({ kind: "phase", phase: this.draft.phase });
    return { ok: true };
  }

  /** Add a channel ahead of approval (so it can be tested and probed); `apiKey` goes to the secret store, never to YAML. */
  async addChannel(channel: DraftChannelInput, apiKey?: string): Promise<DraftChannelResult> {
    const res = await addDraftChannel(this.deps, this.draft, channel, apiKey);
    await this.persist();
    return res;
  }

  /** Remove a channel this session added. */
  async removeChannel(id: string): Promise<DraftChannelResult> {
    const res = await removeDraftChannel(this.deps, this.draft, id);
    if (res.ok) await this.persist();
    return res;
  }

  /** Cancel from any phase: drop the draft, every secret this session created and every channel it wrote; leaves user YAML as it was. */
  async cancel(): Promise<void> {
    for (const ref of this.draft.secretsCreated) await this.deps.deleteSecret?.(ref);
    await rollbackDraftChannels(this.deps, this.draft);
    this.draft.phase = "cancelled";
    await this.deps.files.delete(this.draftPath);
    this.emit({ kind: "phase", phase: "cancelled" });
  }

  startEvaluation(total: number): void {
    this.draft.evaluation = { done: 0, total, tally: { evaluated: 0, unavailable: 0, skipped: 0 }, results: {} };
    this.emitProgress();
  }

  /** One candidate reaches a final state; `done` is monotonic and ≤ total, `tally` sums to `done`. */
  recordCandidate(model: string, state: "evaluated" | "unavailable" | "skipped", result?: unknown, error?: string): void {
    const ev = this.draft.evaluation;
    if (!ev || ev.done >= ev.total) return;
    ev.done++;
    ev.tally[state]++;
    if (state === "evaluated") ev.results[model] = result;
    this.emit({ kind: "model", model, state, result: state === "evaluated" ? result : undefined, error });
    this.emitProgress();
  }

  finishEvaluation(): void {
    if (this.draft.evaluation) this.draft.evaluation.finished = true;
    this.flushProgress();
  }

  emitRating(state: "started" | "done" | "skipped"): void {
    this.emit({ kind: "rating", state });
  }
  emitUsage(inTokens: number, outTokens: number, costUsd?: number): void {
    this.emit({ kind: "usage", inTokens, outTokens, costUsd });
  }

  /** Rendered file set for the approve step; the token binds approval to exactly this content + on-disk base. */
  async review(): Promise<{ token: string; files: Record<string, string>; base: Record<string, string | undefined> }> {
    if (!this.draft.files || Object.keys(this.draft.files).length === 0) throw new Error("nothing to review: stage draft.files first");
    const base = await this.deps.readUserFiles();
    this.draft.baseHash = hash(JSON.stringify(SETUP_FILES.map((f) => base[f] ?? "")));
    const files = composeFiles(this.draft, base);
    this.draft.approvalToken = hash(JSON.stringify(files));
    await this.persist();
    return { token: this.draft.approvalToken, files, base: backupBase(this.draft, base) };
  }

  /**
   * All-or-nothing save: stale-approval check → backup → validate merged →
   * atomic writes in order → restore on failure → delete draft.
   */
  async approveAndSave(token: string): Promise<{ ok: boolean; error?: string }> {
    const d = this.draft;
    if (d.phase === "saved") return { ok: false, error: "already saved" };
    if (!d.files) return { ok: false, error: "no staged files" };
    if (token !== d.approvalToken) return { ok: false, error: "stale_approval" };
    const base = await this.deps.readUserFiles();
    if (hash(JSON.stringify(SETUP_FILES.map((f) => base[f] ?? ""))) !== d.baseHash) return { ok: false, error: "stale_approval" };
    const files = composeFiles(d, base);
    const invalid = this.deps.validateFiles?.(files);
    if (invalid) return { ok: false, error: invalid };

    const backupDir = `${this.deps.stateDir}/setup-backups/${this.now()}`;
    await backupSetupFiles(this.deps, backupBase(d, base), backupDir);
    try {
      await writeSetupFiles(this.deps, files);
    } catch (e) {
      await restoreSetupFiles(this.deps, base);
      return { ok: false, error: `save failed; restored backup: ${e instanceof Error ? e.message : e}` };
    }
    d.phase = "saved";
    await this.deps.files.delete(this.draftPath);
    this.flushProgress();
    this.emit({ kind: "phase", phase: "saved" });
    return { ok: true };
  }

  /** Restore the newest backup into the user config files. */
  async undo(): Promise<{ ok: boolean; error?: string }> {
    const root = `${this.deps.stateDir}/setup-backups`;
    let latest: string | undefined;
    try {
      for (const p of await this.deps.files.list(root)) {
        const dir = p.split("/").slice(-2)[0];
        if (!latest || dir > latest) latest = dir;
      }
    } catch {
      return { ok: false, error: "no backup to restore" };
    }
    if (!latest) return { ok: false, error: "no backup to restore" };
    for (const f of SETUP_FILES) {
      const p = `${root}/${latest}/${f}`;
      if (await this.deps.files.exists(p)) await this.deps.writeUserFile(f, (await this.deps.files.read(p)).content);
    }
    return { ok: true };
  }
}
