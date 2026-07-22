export const DEFAULT_SOURCE_URL = "https://downloads.poaparchive.com/archive.zip";
export const DEFAULT_SOURCE_BYTE_LENGTH = 15_839_405_768;
export const DEFAULT_SOURCE_SHA256 =
  "046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633";
export const DEFAULT_ARTWORK_COUNT = 73_795;

export const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const DEFAULT_CHECKPOINT_PATH = "import-reports/r2-media-upload.checkpoint.jsonl";
export const DEFAULT_REPORT_PATH = "import-reports/r2-media-upload-report.json";
export const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_COMPRESSION_RATIO = 32;

export const ARTWORK_PATH_PATTERN = /^artwork\/([1-9][0-9]*)\.webp$/;
export const SNAPSHOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
