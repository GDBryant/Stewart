import { stringify } from "yaml";
import type { ChannelSummary, SettingsSummary } from "./bridge.js";

export const RULES = [
  { id: "passwords", label: "Passwords", hint: "Passwords, API keys, tokens, private keys and credentials in URLs." },
  { id: "privacy", label: "Privacy", hint: "Email addresses, phone numbers, national ID numbers, payment cards and IBANs." },
] as const;
export type RuleKey = (typeof RULES)[number]["id"];
export type Flags = Partial<Record<RuleKey, boolean>>;

export const GLOBAL_HINT =
  "A blocked message fails the run and nothing is sent; tool results containing a match are withheld and the run continues. Images are not inspected.";
export const CLI_HINT = "Claude CLI channels read files themselves, so only what Stewart sends can be checked; you are asked before each session.";

/** Effective value of a rule on a channel: its override, else the global switch (default on). */
export function effective(global: Flags | undefined, channel: ChannelSummary | undefined, rule: RuleKey): boolean {
  return channel?.security?.[rule] ?? global?.[rule] ?? true;
}

export function isCustom(channel: ChannelSummary, rule: RuleKey): boolean {
  return channel.security?.[rule] !== undefined;
}

/** Channel items with one rule set to a value (undefined = inherit); an empty override is dropped. */
export function withRule(channels: ChannelSummary[], id: string, rule: RuleKey, value: boolean | undefined): ChannelSummary[] {
  return channels.map((c) => {
    if (c.id !== id) return c;
    const next: Flags = { ...c.security };
    if (value === undefined) delete next[rule];
    else next[rule] = value;
    const { security: _old, ...rest } = c;
    return Object.keys(next).length ? { ...rest, security: next } : rest;
  });
}

/** Channels with every override cleared, so all inherit the global values. */
export function withoutOverrides(channels: ChannelSummary[]): ChannelSummary[] {
  return channels.map(({ security: _s, ...rest }) => rest);
}

export const customCount = (channels: ChannelSummary[]): number => channels.filter((c) => c.security && Object.keys(c.security).length).length;

export const channelsYaml = (items: ChannelSummary[]): string => stringify({ version: 1, items }, null, 2);

export function settingsWith(settings: SettingsSummary, rule: RuleKey, value: boolean): string {
  return stringify({ version: 1, ...settings, security: { ...settings.security, [rule]: value } }, null, 2);
}
