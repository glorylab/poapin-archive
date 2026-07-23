import type {
  PortableSiteZipWorkerRequest,
  PortableSiteZipWorkerResponse,
} from "./portable-site-zip.worker-protocol";

const MAX_DROP_FILES = 1_000;
const MAX_DROP_FILE_BYTES = 5 * 1024 * 1024;
const ZIP_WORKER_IDLE_TIMEOUT_MS = 30_000;

export interface PortableSiteZipResult {
  blob: Blob;
  fileCount: number;
  uncompressedBytes: number;
}

export interface PortableSiteZipProgress {
  completedFiles: number;
  totalFiles: number;
}

export async function createPortableSiteZip(
  files: ReadonlyMap<string, Uint8Array>,
  generatedAt: string,
  signal: AbortSignal,
  onProgress: (progress: PortableSiteZipProgress) => void = () => undefined,
): Promise<PortableSiteZipResult> {
  signal.throwIfAborted();
  if (files.size === 0 || files.size > MAX_DROP_FILES) {
    throw new Error(
      `The site package must contain between 1 and ${MAX_DROP_FILES.toLocaleString("en-US")} files.`,
    );
  }

  const input: Array<readonly [path: string, contents: Uint8Array]> = [];
  let uncompressedBytes = 0;
  for (const [path, contents] of files) {
    assertSafeArchivePath(path);
    if (contents.byteLength > MAX_DROP_FILE_BYTES) {
      throw new Error(`${path} exceeds Cloudflare Drop's 5 MiB file limit.`);
    }
    uncompressedBytes += contents.byteLength;
    input.push([path, contents]);
  }

  let blob: Blob;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    blob = await compressOnMainThread(input, generatedAt, signal, onProgress);
  } else {
    try {
      blob = await compressWithDedicatedWorker(input, generatedAt, signal, onProgress);
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      onProgress({ completedFiles: 0, totalFiles: input.length });
      blob = await compressOnMainThread(input, generatedAt, signal, onProgress);
    }
  }

  signal.throwIfAborted();
  return {
    blob,
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

function compressWithDedicatedWorker(
  files: ReadonlyArray<readonly [path: string, contents: Uint8Array]>,
  generatedAt: string,
  signal: AbortSignal,
  onProgress: (progress: PortableSiteZipProgress) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./portable-site-zip.worker.ts", import.meta.url), {
        type: "module",
        name: "poapin-portable-site-zip",
      });
    } catch (cause) {
      reject(cause);
      return;
    }

    const chunks: BlobPart[] = [];
    let settled = false;
    let ready = false;
    let nextFileIndex = 0;
    let watchdog: number | undefined;

    worker.onmessage = (event: MessageEvent<PortableSiteZipWorkerResponse>) => {
      if (settled) return;
      resetWatchdog();
      const message = event.data;
      if (message.type === "ready") {
        if (ready) {
          fail(new Error("The ZIP worker started more than once."));
          return;
        }
        ready = true;
        sendNextFile();
        return;
      }
      if (message.type === "error") {
        fail(new Error(message.message));
        return;
      }
      if (message.type === "progress") {
        if (
          message.totalFiles !== files.length ||
          message.completedFiles !== nextFileIndex ||
          message.completedFiles < 1 ||
          message.completedFiles > files.length
        ) {
          fail(new Error("The ZIP worker returned invalid progress."));
          return;
        }
        onProgress(message);
        if (message.completedFiles < files.length) sendNextFile();
        return;
      }

      chunks.push(message.data);
      if (message.final) finish(new Blob(chunks, { type: "application/zip" }));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message || "The ZIP worker could not start."));
    };
    worker.onmessageerror = () => {
      fail(new Error("The ZIP worker returned an unreadable response."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    resetWatchdog();
    post({
      type: "start",
      generatedAt,
      totalFiles: files.length,
    });

    function sendNextFile(): void {
      if (settled || nextFileIndex >= files.length) return;
      if (signal.aborted) {
        abort();
        return;
      }
      const [path, contents] = files[nextFileIndex];
      const ownedContents = contents.slice() as Uint8Array<ArrayBuffer>;
      const request: PortableSiteZipWorkerRequest = {
        type: "file",
        index: nextFileIndex,
        path,
        contents: ownedContents,
      };
      nextFileIndex += 1;
      post(request, [ownedContents.buffer]);
    }

    function post(message: PortableSiteZipWorkerRequest, transfer?: Transferable[]): void {
      try {
        worker.postMessage(message, transfer ?? []);
      } catch (cause) {
        fail(cause);
      }
    }

    function resetWatchdog(): void {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        fail(new Error("The ZIP worker stopped responding."));
      }, ZIP_WORKER_IDLE_TIMEOUT_MS);
    }

    function finish(blob: Blob): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(blob);
    }

    function fail(cause: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause instanceof Error ? cause : new Error("The ZIP worker stopped unexpectedly."));
    }

    function abort(): void {
      fail(signal.reason);
    }

    function cleanup(): void {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    }
  });
}

async function compressOnMainThread(
  files: ReadonlyArray<readonly [path: string, contents: Uint8Array]>,
  generatedAt: string,
  signal: AbortSignal,
  onProgress: (progress: PortableSiteZipProgress) => void,
): Promise<Blob> {
  const { Zip, ZipDeflate } = await import("fflate");
  const chunks: BlobPart[] = [];
  let compressionError: Error | null = null;
  let finalChunkSeen = false;
  const archive = new Zip((error, data, final) => {
    if (error) {
      compressionError = error;
      return;
    }
    chunks.push(ownBlobPart(data));
    if (final) finalChunkSeen = true;
  });

  try {
    for (let index = 0; index < files.length; index += 1) {
      signal.throwIfAborted();
      const [path, contents] = files[index];
      const entry = new ZipDeflate(path, { level: 6 });
      entry.mtime = generatedAt;
      archive.add(entry);
      entry.push(contents, true);
      if (compressionError) throw compressionError;
      onProgress({ completedFiles: index + 1, totalFiles: files.length });
      await yieldToMainThread(signal);
    }
    archive.end();
    if (compressionError) throw compressionError;
    if (!finalChunkSeen) throw new Error("The ZIP compressor did not finish the archive.");
    signal.throwIfAborted();
    return new Blob(chunks, { type: "application/zip" });
  } catch (cause) {
    archive.terminate();
    throw cause;
  }
}

function ownBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer) {
    return data as Uint8Array<ArrayBuffer>;
  }
  return data.slice() as Uint8Array<ArrayBuffer>;
}

function yieldToMainThread(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(done, 0);
    signal.addEventListener("abort", abort, { once: true });

    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}
