import { err, ok, type Result } from "@stewart/kernel";

/** Task DAG for one run: dependency validation, readiness, per-channel parallelism. */
export interface TaskSpec {
  id: string;
  roleId: string;
  title: string;
  task: string;
  files: string[];
  dependsOn: string[];
  expect?: string;
  acceptanceCriteria?: string;
  sourceRef?: string;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "parked"
  | "stopped"
  | "cancelled";

export interface TaskRecord extends TaskSpec {
  status: TaskStatus;
  summary?: string;
  error?: string;
  filesTouched: string[];
}

export class TaskGraph {
  private tasks = new Map<string, TaskRecord>();

  add(spec: TaskSpec): Result<TaskRecord> {
    if (this.tasks.has(spec.id)) return err("duplicate_task_id", `duplicate task id: ${spec.id}`);
    const rec: TaskRecord = { ...spec, status: "pending", filesTouched: [] };
    this.tasks.set(spec.id, rec);
    return ok(rec);
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  all(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  toJSON(): TaskRecord[] {
    return this.all().map((t) => ({ ...t, files: [...t.files], dependsOn: [...t.dependsOn], filesTouched: [...t.filesTouched] }));
  }

  static fromJSON(records: TaskRecord[]): TaskGraph {
    const g = new TaskGraph();
    for (const r of records) {
      g.tasks.set(r.id, { ...r, files: [...(r.files ?? [])], dependsOn: [...(r.dependsOn ?? [])], filesTouched: [...(r.filesTouched ?? [])] });
    }
    return g;
  }

  /** Deps must exist and be acyclic; returns the offending ids, empty when valid. */
  validate(): string[] {
    const errors: string[] = [];
    for (const t of this.tasks.values()) {
      for (const d of t.dependsOn) {
        if (!this.tasks.has(d)) errors.push(`task ${t.id}: unknown dependsOn '${d}'`);
      }
    }
    const cycle = this.findCycle();
    if (cycle) errors.push(`task dependency cycle: ${cycle.join(" → ")}`);
    return errors;
  }

  /** Pending tasks whose dependencies are all done. */
  ready(): TaskRecord[] {
    return this.all().filter(
      (t) => t.status === "pending" && t.dependsOn.every((d) => this.tasks.get(d)?.status === "done"),
    );
  }

  /** Pending tasks that can never run because a dependency failed, parked or stopped. */
  blockedByFailure(): TaskRecord[] {
    const dead = new Set(["failed", "parked", "stopped", "cancelled"]);
    return this.all().filter(
      (t) => t.status === "pending" && t.dependsOn.some((d) => dead.has(this.tasks.get(d)?.status ?? "pending")),
    );
  }

  get finished(): boolean {
    return this.all().every((t) => !["pending", "running", "waiting"].includes(t.status));
  }

  private findCycle(): string[] | undefined {
    const state = new Map<string, number>();
    const stack: string[] = [];
    const walk = (id: string): string[] | undefined => {
      const s = state.get(id);
      if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
      if (s === 2) return undefined;
      state.set(id, 1);
      stack.push(id);
      for (const d of this.tasks.get(id)?.dependsOn ?? []) {
        const c = walk(d);
        if (c) return c;
      }
      stack.pop();
      state.set(id, 2);
      return undefined;
    };
    for (const id of this.tasks.keys()) {
      const c = walk(id);
      if (c) return c;
    }
    return undefined;
  }
}
