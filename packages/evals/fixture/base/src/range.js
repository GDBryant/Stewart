export function range(start, end) {
  const out = [];
  for (let i = start; i < end - 1; i++) out.push(i);
  return out;
}
