import assert from "node:assert/strict";
import test from "node:test";

import { mediaInternals } from "../lib/media.mjs";

test("dead Collections media host is rewritten to the audited bucket", () => {
  const result = mediaInternals.resolveSourceUrl(
    "https://collections-assets.poap.xyz/a/b/image.png",
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.url.toString(),
    "https://collections-media-production.s3.us-east-2.amazonaws.com/a/b/image.png",
  );
  assert.equal(result.rewritten, "collections-assets-to-production-s3-v1");
});

test("unknown and credentialed media hosts fail closed", () => {
  const unknown = mediaInternals.resolveSourceUrl("https://example.invalid/image.png");
  const credentialed = mediaInternals.resolveSourceUrl(
    "https://user:secret@assets.poap.xyz/image.png",
  );

  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "SOURCE_HOST_NOT_ALLOWED");
  assert.equal(credentialed.ok, false);
  assert.equal(credentialed.code, "INVALID_SOURCE_URL");
});

test("private network ranges are rejected", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"]) {
    assert.equal(mediaInternals.isPrivateAddress(address), true, address);
  }
  assert.equal(mediaInternals.isPrivateAddress("1.1.1.1"), false);
  assert.equal(mediaInternals.isPrivateAddress("2606:4700:4700::1111"), false);
});

test("image signatures are detected independently of URL extensions", () => {
  assert.deepEqual(
    mediaInternals.detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    { contentType: "image/png", extension: "png" },
  );
  assert.deepEqual(mediaInternals.detectImage(Buffer.from("GIF89a")), {
    contentType: "image/gif",
    extension: "gif",
  });
  assert.equal(mediaInternals.detectImage(Buffer.from("not an image")), null);
});
