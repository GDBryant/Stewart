const UNITS = { h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  let total = 0;
  let matched = "";
  for (const [part, n, unit] of text.matchAll(/(\d+)([hms])/g)) {
    total += Number(n) * UNITS[unit];
    matched += part;
  }
  if (!matched || matched !== text) throw new Error(`invalid duration: ${text}`);
  return total;
}
