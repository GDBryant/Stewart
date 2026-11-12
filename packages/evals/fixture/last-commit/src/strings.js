export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function words(s) {
  return s.trim().split(/\s+/).filter(Boolean);
}

export function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
