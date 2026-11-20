import type { ManagedChannel } from "@stewart/channels";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { RunEvent } from "@stewart/protocol";

/** Failure text prefix shared by every business-policy refusal; the task chain keys on it. */
export const POLICY_FAIL = "business_policy:";

export const policyFailed = (error: string | undefined): boolean => error?.startsWith(POLICY_FAIL) === true;

/** `Continue` answers for Claude CLI channels, by lead session + channel. Memory only: reset when core restarts. */
const continued = new Set<string>();

export function resetPolicyAnswers(): void {
  continued.clear();
}

export interface GateCtx {
  spec: { runId: string; sessionId: string; role: { id: string }; interactive: boolean; run: { controller: AbortController } };
  deps: { bus: { emit(ev: RunEvent): void }; interaction?: Interaction };
}

function refusal(channel: string): string {
  return `${POLICY_FAIL} refused: channel ${channel} uses the Claude CLI, which reads files itself; business policy can only check what Stewart sends it`;
}

/**
 * Claude CLI channels with rules ticked: ask once per session + channel whether to continue, since the CLI reads files and
 * runs tools itself and Stewart cannot check that content. Children cannot prompt: they inherit the lead's answer.
 * Returns the refusal text, or undefined to proceed.
 */
export async function cliPolicyGate(c: GateCtx, channel: ManagedChannel): Promise<string | undefined> {
  const rules = channel.policyRules;
  if (channel.cfg.type !== "claude-cli" || !rules.length) return undefined;
  const id = channel.cfg.id;
  const key = `${c.spec.sessionId.split("/")[0]}|${id}`;
  if (continued.has(key)) return undefined;
  if (c.spec.interactive && c.deps.interaction && (await asked(c, id))) {
    continued.add(key);
    return undefined;
  }
  for (const rule of rules) c.deps.bus.emit({ kind: "policy.notice", runId: c.spec.runId, roleId: c.spec.role.id, channel: id, rule, action: "refused", where: "system", msgIndex: 0 });
  return refusal(id);
}

async function asked(c: GateCtx, id: string): Promise<boolean> {
  const q = `Channel ${id} uses the Claude CLI, which reads files itself; business policy can only check what Stewart sends. Continue anyway, or stop?`;
  const o = await c.deps.interaction!.ask(questionPrompt("fallback", q, ["Continue", "Stop"]), { runId: c.spec.runId, roleId: c.spec.role.id }, c.spec.run.controller.signal);
  return o.kind === "answered" && o.value === "Continue";
}
