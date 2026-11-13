import type { RoleDef } from "@stewart/config";
import type { ApproveFn } from "@stewart/permissions";
import { actionOf, decide } from "@stewart/tools";

/**
 * One policy decision before the permission gate, for both engines: a denied action is rejected without
 * reaching the user prompt; allowed actions go through the normal gate tagged with the role.
 */
export function policyApprove(role: RoleDef, gate: ApproveFn): ApproveFn {
  return async (call, preview, meta) => {
    const d = decide(role, actionOf(preview));
    if (!d.allow) return { kind: "rejected", reason: d.reason };
    return gate(call, preview, { ...meta, roleId: role.id });
  };
}
