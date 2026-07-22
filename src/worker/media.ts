const TRAILING_SLASHES = /\/+$/;

/** Returns the immutable R2 custom-domain path for an archived original. */
export function artworkUrl(mediaBaseUrl: string, snapshotId: string, dropId: number): string {
  return `${mediaBaseUrl.replace(TRAILING_SLASHES, "")}/snapshots/${encodeURIComponent(snapshotId)}/artwork/${dropId}.webp`;
}
