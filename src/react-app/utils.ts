import type { MomentMediaPreview } from "./types";

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

export function safeHttpUrl(value?: string | null): string | null {
  if (!value || value.length > 2_048) return null;

  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function safeMomentMediaUrl(value?: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://media.poap.in" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match = url.pathname.match(
      /^\/snapshots\/[a-z0-9][a-z0-9._-]{0,63}\/moments\/(original|thumbnail)\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]+)$/,
    );
    if (!match || match[2] !== match[3].slice(0, 2)) return null;
    const [, variant, , , extension] = match;
    if (variant === "thumbnail") return extension === "webp" ? url.toString() : null;
    return MOMENT_MEDIA_EXTENSIONS.has(extension) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isBrowserRenderableMomentImage(
  media: Pick<MomentMediaPreview, "kind" | "mimeType" | "url">,
): boolean {
  if (media.kind !== "image") return false;

  const mimeType = media.mimeType?.trim().toLowerCase() ?? "";
  if (NON_RENDERABLE_IMAGE_MIME_TYPES.has(mimeType)) return false;

  try {
    const extension = new URL(media.url).pathname.split(".").pop()?.toLowerCase();
    return !extension || !NON_RENDERABLE_IMAGE_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

const NON_RENDERABLE_IMAGE_MIME_TYPES = new Set([
  "image/dng",
  "image/heic",
  "image/heif",
  "image/x-adobe-dng",
]);
const NON_RENDERABLE_IMAGE_EXTENSIONS = new Set(["dng", "heic", "heif"]);

const MOMENT_MEDIA_EXTENSIONS = new Set([
  "jpg",
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "dng",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "m4a",
  "ogg",
  "wav",
  "flac",
  "aac",
  "bin",
]);
