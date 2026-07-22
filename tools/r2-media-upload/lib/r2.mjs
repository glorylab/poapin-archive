import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";

export class R2ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "R2ConfigurationError";
    this.code = "INVALID_R2_CONFIGURATION";
  }
}

export class ExistingObjectConflictError extends Error {
  constructor(key) {
    super(`${key} already exists but does not match the source bytes and public cache metadata.`);
    this.name = "ExistingObjectConflictError";
    this.code = "EXISTING_OBJECT_CONFLICT";
  }
}

export function createR2Target({
  accountId = process.env.R2_ACCOUNT_ID,
  endpoint = process.env.R2_ENDPOINT,
  bucket = process.env.R2_BUCKET,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
} = {}) {
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new R2ConfigurationError("R2_BUCKET/--bucket must be a valid lowercase R2 bucket name.");
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new R2ConfigurationError(
      "Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment; secrets are not accepted as CLI flags.",
    );
  }

  let endpointUrl;
  if (endpoint) {
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      throw new R2ConfigurationError("R2_ENDPOINT must be a valid HTTPS URL.");
    }
    if (
      endpointUrl.protocol !== "https:" ||
      endpointUrl.username ||
      endpointUrl.password ||
      endpointUrl.search ||
      endpointUrl.hash ||
      endpointUrl.pathname !== "/"
    ) {
      throw new R2ConfigurationError(
        "R2_ENDPOINT must be an HTTPS origin without credentials, a path, a query, or a fragment.",
      );
    }
  } else {
    if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
      throw new R2ConfigurationError(
        "R2_ACCOUNT_ID must be the 32-character Cloudflare account ID.",
      );
    }
    endpointUrl = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  }

  const client = new S3Client({
    region: "auto",
    endpoint: endpointUrl.href,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    bucket,
    endpoint: endpointUrl.origin,
    client,
    secrets: [accessKeyId, secretAccessKey],
  };
}

export class ImmutableR2Uploader {
  constructor({
    client,
    bucket,
    cacheControl,
    attempts = 4,
    secrets = [],
    sleep = delay,
    random = Math.random,
  }) {
    this.client = client;
    this.bucket = bucket;
    this.cacheControl = cacheControl;
    this.attempts = attempts;
    this.secrets = secrets.filter(Boolean);
    this.sleep = sleep;
    this.random = random;
  }

  async upload({ key, bytes, sha256, contentMd5, signal }) {
    let latestError;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        return await this.#putOrReuse({ key, bytes, sha256, contentMd5, signal });
      } catch (error) {
        latestError = error;
        if (signal?.aborted || !isRetryable(error) || attempt === this.attempts) break;
        const waitMs = Math.round(250 * 2 ** (attempt - 1) * (0.75 + this.random() * 0.5));
        try {
          await this.sleep(waitMs, undefined, { signal });
        } catch (sleepError) {
          latestError = sleepError;
          break;
        }
      }
    }

    const wrapped = new Error(redactErrorMessage(latestError, this.secrets));
    wrapped.name = latestError?.name ?? "R2UploadError";
    wrapped.code = latestError?.code ?? latestError?.name ?? "R2_UPLOAD_FAILED";
    wrapped.attempts = attemptsMade;
    wrapped.httpStatus = latestError?.$metadata?.httpStatusCode ?? null;
    throw wrapped;
  }

  async #putOrReuse({ key, bytes, sha256, contentMd5, signal }) {
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: "image/webp",
          ContentMD5: contentMd5,
          CacheControl: this.cacheControl,
          IfNoneMatch: "*",
          Metadata: {
            sha256,
            source: "poap-archive",
          },
        }),
        { abortSignal: signal },
      );
      return { disposition: "uploaded", etag: cleanEtag(result.ETag) };
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }

    const existing = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { abortSignal: signal },
    );
    const matches =
      Number(existing.ContentLength) === bytes.byteLength &&
      existing.Metadata?.sha256 === sha256 &&
      existing.ContentType === "image/webp" &&
      existing.CacheControl === this.cacheControl;
    if (!matches) throw new ExistingObjectConflictError(key);
    return { disposition: "reused", etag: cleanEtag(existing.ETag) };
  }
}

export function isRetryable(error) {
  if (error instanceof ExistingObjectConflictError) return false;
  const status = error?.$metadata?.httpStatusCode;
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  if (typeof status === "number") return false;
  return error?.name !== "AbortError";
}

export function redactErrorMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error ?? "Unknown R2 error");
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  message = message.replace(
    /([?&][^=&\s]*(?:token|key|secret|signature|credential)[^=&\s]*=)[^&\s]+/gi,
    "$1[redacted]",
  );
  return message.slice(0, 600);
}

function isPreconditionFailed(error) {
  return (
    error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.code === "PreconditionFailed"
  );
}

function cleanEtag(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : null;
}
