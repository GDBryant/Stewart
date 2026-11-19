import type { SlashCommandInfo } from "@stewart/protocol";

const OPEN_RE = /^\/[a-z0-9-]*$/i;

export function slashMenuOpen(draft: string): boolean {
  return OPEN_RE.test(draft);
}

export function slashMenuFilter(commands: SlashCommandInfo[], draft: string): SlashCommandInfo[] {
  const prefix = draft.slice(1).toLowerCase();
  return commands.filter(
    (c) => c.name.toLowerCase().startsWith(prefix) || (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(prefix)),
  );
}

export function slashMenuMove(selected: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((selected + delta) % count) + count) % count;
}

export function slashMenuComplete(c: SlashCommandInfo): string {
  return `/${c.name} `;
}
