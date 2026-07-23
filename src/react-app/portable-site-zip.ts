import { zip, type AsyncZippable } from "fflate";

const MAX_DROP_FILES = 1_000;
const MAX_DROP_FILE_BYTES = 5 * 1024 * 1024;

export interface PortableSiteZipResult {
  blob: Blob;
  fileCount: number;
  uncompressedBytes: number;
}

export async function createPortableSiteZip(
  files: ReadonlyMap<string, Uint8Array>,
  generatedAt: string,
  signal: AbortSignal,
): Promise<PortableSiteZipResult> {
  signal.throwIfAborted();
  if (files.size === 0 || files.size > MAX_DROP_FILES) {
    throw new Error(
      `The site package must contain between 1 and ${MAX_DROP_FILES.toLocaleString("en-US")} files.`,
    );
  }

  const input: AsyncZippable = Object.create(null) as AsyncZippable;
  let uncompressedBytes = 0;
  for (const [path, contents] of files) {
    assertSafeArchivePath(path);
    if (contents.byteLength > MAX_DROP_FILE_BYTES) {
      throw new Error(`${path} exceeds Cloudflare Drop's 5 MiB file limit.`);
    }
    uncompressedBytes += contents.byteLength;
    input[path] = contents;
  }

  const data = await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const operation = zip(input, { level: 6, mtime: generatedAt }, (error, archive) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(archive);
    });
    signal.addEventListener("abort", abort, { once: true });

    function abort() {
      if (settled) return;
      settled = true;
      operation();
      reject(signal.reason);
    }
  });

  signal.throwIfAborted();
  return {
    blob: new Blob([data.buffer as ArrayBuffer], { type: "application/zip" }),
    fileCount: files.size,
    uncompressedBytes,
  };
}

export function portableSiteZipFilename(address: string): string {
  const shortAddress = `${address.slice(0, 8)}-${address.slice(-6)}`;
  return `poapin-personal-site-${shortAddress}.zip`;
}

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`The generated site contains an unsafe path: ${path || "(empty)"}`);
  }
}
