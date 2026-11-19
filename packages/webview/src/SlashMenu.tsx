import type { SlashCommandInfo } from "@stewart/protocol";

export function SlashMenu({ items, selected, onPick }: { items: SlashCommandInfo[]; selected: number; onPick(c: SlashCommandInfo): void }) {
  return (
    <div class="slash-menu">
      {items.map((c, i) => {
        const usage = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
        return (
          <button
            key={c.name}
            type="button"
            class={i === selected ? "slash-item selected" : "slash-item"}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
          >
            <span class="slash-usage">{usage}</span>
            <span class="slash-desc">{c.description}</span>
          </button>
        );
      })}
    </div>
  );
}
