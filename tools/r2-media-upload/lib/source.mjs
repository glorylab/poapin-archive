import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";

export class ArchiveSourceError extends Error {
  constructor(message, code = "ARCHIVE_SOURCE_ERROR") {
    super(message);
    this.name = "ArchiveSourceError";
    this.code = code;
  }
}

export async function openArchiveSource(value, { signal } = {}) {
  const url = parseRemoteUrl(value);
  if (url) return openRemote(url, { signal });

  const filePath = resolve(value);
  const fileStat = await stat(filePath).catch((error) => {
    throw new ArchiveSourceError(
      `Cannot open local archive ${JSON.stringify(basename(filePath))}: ${error.code ?? "unknown error"}.`,
    );
  });
  if (!fileStat.isFile())
    throw new ArchiveSourceError("The local archive source must be a regular file.");
  const stream = createReadStream(filePath);
  const abort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal?.removeEventListener("abort", abort));
  return {
    kind: "local",
    label: basename(filePath),
    byteLength: fileStat.size,
    stream,
  };
}

async function openRemote(url, { signal }) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "application/zip, application/octet-stream;q=0.9",
      "Accept-Encoding": "identity",
      "User-Agent": "poapin-archive-media-uploader/0.1",
    },
    signal,
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    await response.body?.cancel();
    throw new ArchiveSourceError("The archive redirected away from HTTPS.", "INSECURE_REDIRECT");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ArchiveSourceError(
      `Archive request to ${safeUrl(finalUrl)} failed with HTTP ${response.status}.`,
      "ARCHIVE_HTTP_ERROR",
    );
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    await response.body.cancel();
    throw new ArchiveSourceError(
      `Archive response used unexpected Content-Encoding ${JSON.stringify(contentEncoding)}.`,
      "UNEXPECTED_CONTENT_ENCODING",
    );
  }
  const contentLength = parseContentLength(response.headers.get("content-length"));
  return {
    kind: "remote",
    label: safeUrl(finalUrl),
    byteLength: contentLength,
    stream: Readable.fromWeb(response.body),
  };
}

function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    throw new ArchiveSourceError("Remote archive URLs must use HTTPS.", "INSECURE_SOURCE_URL");
  }
  if (url.username || url.password) {
    throw new ArchiveSourceError(
      "Archive URLs must not contain embedded credentials.",
      "CREDENTIALS_IN_SOURCE_URL",
    );
  }
  return url;
}

function parseContentLength(value) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeUrl(url) {
  return `${url.origin}${url.pathname}`;
}

function abortError() {
  const error = new Error("Archive reading was aborted.");
  error.name = "AbortError";
  return error;
}
