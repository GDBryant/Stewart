import { meetsHardRequirements, type Candidate } from "./assign.js";

/** Coerces an untrusted field to a string; anything that is not a string becomes "". */
export const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

export function roleRefusal(role: string, roleIds: Set<string>): string | undefined {
  return roleIds.has(role) ? undefined : `${role || "?"}: unknown role`;
}

/** Refuses a channel or model that was not discovered. */
export function modelRefusal(role: string, channel: string, model: string, byId: Map<string, { models: string[] }>): string | undefined {
  const info = byId.get(channel);
  if (!info) return `${role}: unknown channel '${channel}'`;
  if (!info.models.includes(model)) return `${role}: unknown model '${model}' on ${channel}`;
  return undefined;
}

/** Refuses a candidate that fails the role's hard requirements; unknown candidates pass here. */
export function hardRefusal(role: string, channel: string, model: string, cand: Map<string, Candidate>): string | undefined {
  const c = cand.get(`${channel}:${model}`);
  if (c && !meetsHardRequirements(role, c)) return `${role}: ${channel}:${model} fails hard requirements`;
  return undefined;
}
