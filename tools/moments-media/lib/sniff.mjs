const TYPE_TO_EXTENSION = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/x-adobe-dng": "dng",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
});

export function detectMediaType(bytes, declaredType = null) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) return null;
  const declared = normalizeDeclared(declaredType);
  if (starts(bytes, [0xff, 0xd8, 0xff])) return media("image/jpeg");
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return media("image/png");
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return media("image/gif");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return media("image/webp");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return media("audio/wav");
  }
  if (ascii(bytes, 0, 4) === "OggS") return media("audio/ogg");
  if (ascii(bytes, 0, 4) === "fLaC") return media("audio/flac");
  if (ascii(bytes, 0, 3) === "ID3" || isMpegAudioFrame(bytes)) return media("audio/mpeg");
  if (starts(bytes, [0xff, 0xf1]) || starts(bytes, [0xff, 0xf9])) return media("audio/aac");
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return media("video/webm");
  if (isTiff(bytes) && declared === "image/x-adobe-dng") return media("image/x-adobe-dng");
  if (ascii(bytes, 4, 4) === "ftyp") return detectIsoMedia(bytes, declared);
  return null;
}

export function extensionForContentType(contentType) {
  return TYPE_TO_EXTENSION[contentType] ?? null;
}

export function isDeclaredTypeCompatible(declaredType, detectedType) {
  const declared = normalizeDeclared(declaredType);
  if (!declared) return true;
  if (declared === detectedType) return true;
  if (declared === "audio/x-m4a" && detectedType === "audio/mp4") return true;
  return false;
}

function detectIsoMedia(bytes, declared) {
  const brands = ascii(bytes, 8, Math.min(bytes.byteLength - 8, 28));
  if (/avif|avis/.test(brands)) return media("image/avif");
  if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands) && declared === "image/heic") {
    return media("image/heic");
  }
  if (/M4A |M4B |M4P /.test(brands) || declared === "audio/x-m4a" || declared === "audio/mp4") {
    return media("audio/mp4");
  }
  if (/qt  /.test(brands)) return media("video/quicktime");
  return media("video/mp4");
}

function media(contentType) {
  return { contentType, extension: TYPE_TO_EXTENSION[contentType] };
}

function normalizeDeclared(value) {
  if (typeof value !== "string") return null;
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized || null;
}

function starts(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, offset, length) {
  if (offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isMpegAudioFrame(bytes) {
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function isTiff(bytes) {
  return starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
}
