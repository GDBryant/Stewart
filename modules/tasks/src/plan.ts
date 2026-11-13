export interface MilestoneCheck {
  command?: string;
  files?: string[];
}

export type MilestoneStatus = "pending" | "done" | "failed";

export interface Milestone {
  id: string;
  title: string;
  detail: string;
  check: MilestoneCheck;
  status: MilestoneStatus;
  checkpoint?: string;
  attempts: number;
}

export interface Plan {
  goal: string;
  status: "active" | "done";
  sessionId: string;
  milestones: Milestone[];
}

function milestoneBlock(m: Milestone): string {
  const parts: string[] = [`## ${m.id}: ${m.title} [${m.status}]`];
  if (m.detail) parts.push(m.detail);
  const check: string[] = [];
  if (m.check.command) check.push(`\`${m.check.command}\``);
  if (m.check.files?.length) check.push(`files: ${m.check.files.join(", ")}`);
  if (check.length) parts.push(`Check: ${check.join("; ")}`);
  if (m.checkpoint) parts.push(`Checkpoint: ${m.checkpoint}`);
  parts.push(`Attempts: ${m.attempts}`);
  return parts.join("\n");
}

/** The exact .stewart/plan.md text for a plan. */
export function renderPlan(plan: Plan): string {
  return `# Plan: ${plan.goal}\n\nStatus: ${plan.status}\nSession: ${plan.sessionId}\n\n${plan.milestones.map(milestoneBlock).join("\n\n")}\n`;
}

function parseCheck(line: string): MilestoneCheck {
  const m = line.match(/^Check: (.*)$/);
  if (!m) throw new Error(`bad Check line: ${line}`);
  const out: MilestoneCheck = {};
  const cmd = m[1].match(/^`([^`]*)`(?:; (.*))?$/);
  if (cmd) {
    out.command = cmd[1];
    if (cmd[2]) out.files = filesOf(cmd[2]);
  } else {
    out.files = filesOf(m[1]);
  }
  return out;
}

function filesOf(s: string): string[] {
  const f = s.match(/^files: (.*)$/);
  if (!f) throw new Error(`bad Check line part: ${s}`);
  return f[1].split(",").map((x) => x.trim());
}

function parseMilestone(id: string, head: string, lines: string[]): Milestone {
  const hm = head.match(/^(.*) \[(pending|done|failed)\]$/);
  if (!hm) throw new Error(`bad milestone header: ## ${id}: ${head}`);
  const m: Milestone = { id, title: hm[1], detail: "", check: {}, status: hm[2] as MilestoneStatus, attempts: 0 };
  const detail: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Check: ")) m.check = parseCheck(line);
    else if (line.startsWith("Checkpoint: ")) m.checkpoint = line.slice(12).trim();
    else if (line.startsWith("Attempts: ")) m.attempts = Number.parseInt(line.slice(10), 10) || 0;
    else detail.push(line);
  }
  m.detail = detail.join("\n").replace(/\n+$/, "");
  return m;
}

/** Parse .stewart/plan.md text; throws a clear error on any malformed part. */
export function parsePlan(text: string): Plan {
  const goal = text.match(/^# Plan: (.*)$/m)?.[1];
  if (!goal) throw new Error("plan.md: missing '# Plan: <goal>' header");
  const status = text.match(/^Status: (active|done)$/m)?.[1] as Plan["status"] | undefined;
  if (!status) throw new Error("plan.md: missing 'Status: active|done'");
  const sessionId = text.match(/^Session: (.*)$/m)?.[1];
  if (!sessionId) throw new Error("plan.md: missing 'Session: <id>'");
  const heads = [...text.matchAll(/^## (M\d+): (.*)$/gm)];
  if (!heads.length) throw new Error("plan.md: no milestones");
  const milestones = heads.map((h, i) => {
    const body = text.slice(h.index! + h[0].length, heads[i + 1]?.index).split("\n").slice(1);
    return parseMilestone(h[1], h[2], body.filter((l) => l.trim() !== ""));
  });
  return { goal, status, sessionId, milestones };
}

/** First milestone not done (pending or failed: a failed milestone blocks the plan), or undefined when all are done. */
export function currentMilestone(plan: Plan): Milestone | undefined {
  return plan.milestones.find((m) => m.status !== "done");
}
