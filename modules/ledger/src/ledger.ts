import type { Clock, HostPort } from "@stewart/kernel";

export interface LedgerEntry {
  runId: string;
  taskId?: string;
  roleId?: string;
  agentId: string;
  model: string;
  billing: string;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  at: number;
}

export interface RunCost {
  costUsd: number;
  inTokens: number;
  outTokens: number;
  byRole: Record<string, number>;
  byAgent: Record<string, { costUsd: number; inTokens: number; outTokens: number }>;
}

/**
 * Append-only run ledger with fsync per entry. Entries are replayed on attach so
 * accrued cost survives a crash, an IDE restart and /resume.
 */
export class RunLedger {
  private entries: LedgerEntry[] = [];

  constructor(
    private host: HostPort,
    private path: string,
    private clock: Clock,
  ) {}

  async load(): Promise<void> {
    const lines = await this.host.files.readLines(this.path);
    const out: LedgerEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        /* torn tail after a crash: skip the partial line */
      }
    }
    this.entries = out;
  }

  async record(e: Omit<LedgerEntry, "at">): Promise<LedgerEntry> {
    const entry = { ...e, at: this.clock.now() };
    await this.host.files.appendLine(this.path, JSON.stringify(entry));
    this.entries.push(entry);
    return entry;
  }

  entriesFor(runId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.runId === runId);
  }

  cost(runId: string): RunCost {
    const acc: RunCost = { costUsd: 0, inTokens: 0, outTokens: 0, byRole: {}, byAgent: {} };
    for (const e of this.entriesFor(runId)) {
      acc.costUsd += e.costUsd;
      acc.inTokens += e.inTokens;
      acc.outTokens += e.outTokens;
      const role = e.roleId ?? "(direct)";
      acc.byRole[role] = (acc.byRole[role] ?? 0) + e.costUsd;
      const a = (acc.byAgent[e.agentId] ??= { costUsd: 0, inTokens: 0, outTokens: 0 });
      a.costUsd += e.costUsd;
      a.inTokens += e.inTokens;
      a.outTokens += e.outTokens;
    }
    return acc;
  }
}

/** Cost of one call from an agent's billing mode. */
export function costOfCall(
  agent: { billing?: string; price?: { inPerMTok: number; outPerMTok: number } },
  usage: { in: number; out: number } | undefined,
  reportedUsd: number | undefined,
): number {
  if (!usage && reportedUsd === undefined) return 0;
  if (agent.billing === "free") return 0;
  if (agent.billing === "priced" && agent.price && usage) {
    return (usage.in / 1e6) * agent.price.inPerMTok + (usage.out / 1e6) * agent.price.outPerMTok;
  }
  return reportedUsd ?? 0;
}

/** Cap state for one run: reached, raised by perRunUsd per Continue. */
export class CostLimit {
  private currentCap: number;
  constructor(
    readonly perRunUsd: number,
    readonly onLimit: "ask" | "stop",
    private accruedUsd = 0,
  ) {
    this.currentCap = perRunUsd;
  }

  get cap(): number {
    return this.currentCap;
  }
  get accrued(): number {
    return this.accruedUsd;
  }
  set accrued(v: number) {
    this.accruedUsd = v;
  }
  get enabled(): boolean {
    return this.perRunUsd > 0;
  }
  reached(): boolean {
    return this.enabled && this.accruedUsd >= this.currentCap;
  }
  overshoot(): number {
    return Math.max(0, this.accruedUsd - this.currentCap);
  }
  raise(): number {
    this.currentCap += this.perRunUsd;
    return this.currentCap;
  }
}
