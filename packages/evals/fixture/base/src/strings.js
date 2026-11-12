export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function words(s) {
  return s.trim().split(/\s+/).filter(Boolean);
}
