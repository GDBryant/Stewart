/** Channel colour badges. Every channel id deterministically maps to one fixed
 * palette colour, so a colour is effectively assigned when the channel is set
 * up (wizard or manual add) and stays stable across restarts and both hosts.
 * Role cards reuse the colour of their assigned agent's channel, so the badge
 * follows the agent automatically when it changes. */
export const CHANNEL_PALETTE = [
  "#4da3ff", // blue
  "#57a773", // green
  "#d1a44a", // amber
  "#d9534f", // red
  "#b07de8", // purple
  "#4dd0c4", // teal
  "#e58f5a", // orange
  "#e08fb6", // pink
];

export function channelColor(channelId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    h ^= channelId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CHANNEL_PALETTE[h % CHANNEL_PALETTE.length];
}

export function ChannelDot({ channel, title }: { channel: string; title?: string }) {
  return <span class="ch-dot" title={title} style={{ background: channelColor(channel) }} />;
}
