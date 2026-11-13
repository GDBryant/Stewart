export interface Tried {
  /** Engine call id: outcomes are matched by it (batched calls finish out of order). */
  callId: string;
  name: string;
  args: string;
  ok?: boolean;
}

function shortArgs(t: Tried): string {
  const a = t.args.length > 60 ? `${t.args.slice(0, 60)}…` : t.args;
  return `${t.name}(${a})`;
}

export function handoverText(fromId: string, goal: string, tried: Tried[], evidence: string): string {
  const list = tried.slice(-10).map((t) => `${shortArgs(t)} ${t.ok === false ? "failed" : "ok"}`).join(", ") || "none";
  return `Handover: the previous agent (${fromId}) did not finish this task.\nGoal: ${goal}\nTried: ${list}\nFailing evidence: ${evidence}\nContinue from the current state of the files.`;
}
