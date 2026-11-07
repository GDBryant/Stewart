const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Image media type from a file name's extension; undefined for unknown types. */
export function mediaTypeFor(name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MEDIA_TYPES[ext];
}
