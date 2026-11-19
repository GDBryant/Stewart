import type { SlashCommand, SlashCommandInfo } from "../types.js";

export function helpCommand(list: () => SlashCommandInfo[]): SlashCommand {
  return {
    name: "help",
    argHint: "",
    description: "List commands",
    async run(ctx) {
      const lines = list().map((c) => {
        const usage = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
        return `- \`${usage}\` — ${c.description}`;
      });
      ctx.say(`**Commands**\n${lines.join("\n")}\n\n\`//\` sends a literal leading slash.`);
    },
  };
}
