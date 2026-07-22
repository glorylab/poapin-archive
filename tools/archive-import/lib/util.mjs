import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { once } from "node:events";

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function isSafeInteger(value, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  input.on("data", (chunk) => hash.update(chunk));
  await once(input, "end");
  return hash.digest("hex");
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function describeFile(filePath, { includeHash = true } = {}) {
  const fileStat = await stat(filePath);
  invariant(fileStat.isFile(), `Expected a file: ${filePath}`);
  return {
    byteLength: fileStat.size,
    ...(includeHash ? { sha256: await sha256File(filePath) } : {}),
  };
}

export function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  invariant(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${optionName} must be a positive integer.`,
  );
  return parsed;
}

export function assertSha256(value, optionName) {
  invariant(/^[0-9a-f]{64}$/.test(value), `${optionName} must be a lowercase SHA-256 digest.`);
  return value;
}

export function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) =>
    String(left).localeCompare(String(right), "en"),
  );
}

export function sortNumbers(values) {
  return [...values].sort((left, right) => left - right);
}

export async function writeWithBackpressure(stream, value) {
  if (!stream.write(value)) await once(stream, "drain");
}

export async function endWritable(stream) {
  stream.end();
  await once(stream, "finish");
}

export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

export function isUnsafeArchivePath(value) {
  const normalized = toPosixPath(value);
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

export function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
