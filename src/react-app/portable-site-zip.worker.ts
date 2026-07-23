import { Zip, ZipDeflate } from "fflate";
import type {
  PortableSiteZipWorkerRequest,
  PortableSiteZipWorkerResponse,
} from "./portable-site-zip.worker-protocol";

interface DedicatedZipWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PortableSiteZipWorkerRequest>) => void,
  ): void;
  postMessage(message: PortableSiteZipWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as DedicatedZipWorkerScope;
let archive: Zip | null = null;
let generatedAt = "";
let totalFiles = 0;
let completedFiles = 0;
let failed = false;

scope.addEventListener("message", (event) => {
  try {
    if (event.data.type === "start") {
      startArchive(event.data.generatedAt, event.data.totalFiles);
      return;
    }
    addFile(event.data);
  } catch (cause) {
    fail(cause);
  }
});

function startArchive(timestamp: string, fileCount: number): void {
  if (archive || fileCount < 1 || !Number.isSafeInteger(fileCount)) {
    throw new Error("The ZIP worker received an invalid start request.");
  }
  const mtime = new Date(timestamp);
  if (Number.isNaN(mtime.getTime())) {
    throw new Error("The ZIP worker received an invalid archive timestamp.");
  }

  generatedAt = timestamp;
  totalFiles = fileCount;
  archive = new Zip((error, data, final) => {
    if (error) {
      fail(error);
      return;
    }
    if (failed) return;
    const transferable = ownBytes(data);
    scope.postMessage(
      {
        type: "chunk",
        data: transferable,
        final,
      },
      [transferable.buffer],
    );
  });
  scope.postMessage({ type: "ready" });
}

function addFile(request: Extract<PortableSiteZipWorkerRequest, { type: "file" }>): void {
  if (
    !archive ||
    failed ||
    request.index !== completedFiles ||
    completedFiles >= totalFiles ||
    request.path.length === 0
  ) {
    throw new Error("The ZIP worker received files out of order.");
  }

  const entry = new ZipDeflate(request.path, { level: 6 });
  entry.mtime = generatedAt;
  archive.add(entry);
  entry.push(request.contents, true);
  if (failed) return;

  completedFiles += 1;
  scope.postMessage({
    type: "progress",
    completedFiles,
    totalFiles,
  });
  if (completedFiles === totalFiles) archive.end();
}

function fail(cause: unknown): void {
  if (failed) return;
  failed = true;
  archive?.terminate();
  scope.postMessage({
    type: "error",
    message: cause instanceof Error ? cause.message : "The ZIP worker stopped unexpectedly.",
  });
}

function ownBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data as Uint8Array<ArrayBuffer>;
  }
  return data.slice() as Uint8Array<ArrayBuffer>;
}
