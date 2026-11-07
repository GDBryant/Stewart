import type { ChatMessage } from "@stewart/kernel";

/** v1 ImageLimits: 5 MB per image, 50 MB read cap, 5 per message. */
export const IMAGE_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxReadBytes: 50 * 1024 * 1024,
  maxPerMessage: 5,
};

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function mediaTypeFor(name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MEDIA_TYPES[ext];
}

/** Base64 string or `data:` URI → { mediaType, base64 }. */
export function parseImageData(raw: string): { mediaType: string; base64: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
  if (m) return { mediaType: m[1], base64: m[2] };
  return { mediaType: "image/png", base64: raw };
}

/** Attachments for a new user message: enforce count/size limits, normalize to data URIs. */
export function normalizeImages(images: string[]): { images: string[]; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  for (const raw of images.slice(0, IMAGE_LIMITS.maxPerMessage)) {
    const { base64, mediaType } = parseImageData(raw);
    const bytes = Math.floor(base64.length * 0.75);
    if (bytes > IMAGE_LIMITS.maxBytes) {
      dropped++;
      continue;
    }
    out.push(`data:${mediaType};base64,${base64}`);
  }
  dropped += Math.max(0, images.length - IMAGE_LIMITS.maxPerMessage);
  return { images: out, dropped };
}
