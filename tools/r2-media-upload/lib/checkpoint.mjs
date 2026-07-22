import { open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const CHECKPOINT_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class CheckpointError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckpointError";
    this.code = "INVALID_CHECKPOINT";
  }
}

export class JsonlCheckpoint {
  #handle = null;
  #pendingSinceSync = 0;
  #writeChain = Promise.resolve();
  #repairContents = null;

  constructor(filePath, { syncEvery = 100 } = {}) {
    this.filePath = resolve(filePath);
    this.syncEvery = syncEvery;
    this.completed = new Map();
    this.warning = null;
  }

  async open(context) {
    await mkdir(dirname(this.filePath), { recursive: true });
    let existing = null;
    try {
      existing = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (existing !== null && existing.length > 0) this.#load(existing, context);
    if (this.#repairContents !== null) {
      await writeFile(this.filePath, this.#repairContents, { encoding: "utf8", mode: 0o600 });
    }
    this.#handle = await open(this.filePath, "a", 0o600);
    if (existing === null || existing.length === 0) {
      await this.#write(
        { kind: "header", version: CHECKPOINT_VERSION, ...context },
        { forceSync: true },
      );
    }
    return this;
  }

  has(key) {
    return this.completed.has(key);
  }

  get(key) {
    return this.completed.get(key) ?? null;
  }

  async record({ key, byteLength, sha256, disposition, etag = null }) {
    assertCompletion({
      kind: "object",
      version: CHECKPOINT_VERSION,
      key,
      byteLength,
      sha256,
      disposition,
    });
    const record = {
      kind: "object",
      version: CHECKPOINT_VERSION,
      key,
      byteLength,
      sha256,
      disposition,
      ...(etag ? { etag } : {}),
      completedAt: new Date().toISOString(),
    };
    this.completed.set(key, record);
    await this.#write(record);
  }

  async close() {
    await this.#writeChain;
    if (this.#handle) {
      if (this.#pendingSinceSync > 0) await this.#handle.sync();
      await this.#handle.close();
      this.#handle = null;
    }
  }

  #load(contents, expectedContext) {
    const lines = contents.split("\n");
    const records = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        const isLastNonEmpty = lines.slice(index + 1).every((candidate) => candidate.trim() === "");
        if (!isLastNonEmpty) {
          throw new CheckpointError(`Checkpoint has invalid JSON on line ${index + 1}.`);
        }
        this.warning = `Ignored a truncated final checkpoint line (${index + 1}).`;
        this.#repairContents = `${lines.slice(0, index).join("\n")}\n`;
      }
    }

    const header = records.shift();
    if (!header || header.kind !== "header" || header.version !== CHECKPOINT_VERSION) {
      throw new CheckpointError(
        `Checkpoint must begin with a version ${CHECKPOINT_VERSION} header.`,
      );
    }
    for (const [name, expected] of Object.entries(expectedContext)) {
      if (header[name] !== expected) {
        throw new CheckpointError(
          `Checkpoint ${name} does not match this run; use a different --checkpoint path.`,
        );
      }
    }

    for (const record of records) {
      assertCompletion(record);
      this.completed.set(record.key, record);
    }
  }

  async #write(record, { forceSync = false } = {}) {
    if (!this.#handle) throw new CheckpointError("Checkpoint is not open.");
    const line = `${JSON.stringify(record)}\n`;
    this.#writeChain = this.#writeChain.then(async () => {
      await this.#handle.write(line);
      this.#pendingSinceSync += 1;
      if (forceSync || this.#pendingSinceSync >= this.syncEvery) {
        await this.#handle.sync();
        this.#pendingSinceSync = 0;
      }
    });
    await this.#writeChain;
  }
}

function assertCompletion(record) {
  if (
    !record ||
    record.kind !== "object" ||
    record.version !== CHECKPOINT_VERSION ||
    typeof record.key !== "string" ||
    !/^snapshots\/[a-z0-9][a-z0-9._-]{0,63}\/artwork\/[1-9][0-9]*\.webp$/.test(record.key) ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength <= 0 ||
    !SHA256_PATTERN.test(record.sha256) ||
    !["uploaded", "reused"].includes(record.disposition)
  ) {
    throw new CheckpointError("Checkpoint contains an invalid object record.");
  }
}

export function createMemoryCheckpoint(initial = []) {
  const completed = new Map(initial.map((record) => [record.key, record]));
  return {
    completed,
    warning: null,
    has: (key) => completed.has(key),
    get: (key) => completed.get(key) ?? null,
    async record(record) {
      completed.set(record.key, record);
    },
    async close() {},
  };
}
