import type { BudgetProfileName } from "@stewart/budget";

export interface ChatCommand {
  direct: boolean;
  profileName?: BudgetProfileName;
  text: string;
}

/** `/direct`, `/quick`, `/deep` prefixes → mode + budget profile + stripped text. */
export function parseChatCommand(text: string, profile?: string): ChatCommand {
  const direct = text.startsWith("/direct ");
  let raw = direct ? text.slice(8) : text;
  let profileName = (["quick", "normal", "deep"] as const).find((n) => n === profile);
  const pre = raw.match(/^\/(quick|deep)\s+/);
  if (pre) {
    profileName = pre[1] as BudgetProfileName;
    raw = raw.slice(pre[0].length);
  }
  return { direct, profileName, text: raw };
}
