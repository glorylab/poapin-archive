import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

const MOMENT_ID = "00000000-0000-4000-8000-000000000001";
const AUDIO_MOMENT_ID = "00000000-0000-4000-8000-000000000002";
const VIDEO_URL =
  "https://media.poap.in/snapshots/moments-2026-07-23-v1/moments/original/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4";
const AUDIO_URL =
  "https://media.poap.in/snapshots/moments-2026-07-23-v1/moments/original/sha256/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp3";
const IMAGE_MOMENT_ID = "00000000-0000-4000-8000-000000000003";
const IMAGE_URLS = ["c", "d", "e", "f", "3", "4"].map((character) => mediaUrl(character, "jpg"));
const HEIC_URL = mediaUrl("1", "heic");
const DNG_URL = mediaUrl("2", "dng");

const moment = {
  momentId: MOMENT_ID,
  displayId: "browser-media-policy",
  author: "0x1111111111111111111111111111111111111111",
  description: "A browser fixture that must never preload media.",
  createdOn: "2026-07-23T00:00:00.000Z",
  updatedOn: null,
  isUpdated: false,
  sourceMediaCount: 2,
  mediaCount: 2,
  mediaPreservationState: "complete",
  previewMedia: {
    mediaId: "00000000-0000-4000-8000-000000000101",
    kind: "video",
    mimeType: "video/mp4",
    url: VIDEO_URL,
    thumbnailUrl: null,
    width: 1280,
    height: 720,
  },
  dropIds: [1],
  collectionIds: [1],
  cid: null,
  tokenId: null,
  media: [
    {
      mediaId: "00000000-0000-4000-8000-000000000101",
      kind: "video",
      mimeType: "video/mp4",
      url: VIDEO_URL,
      thumbnailUrl: null,
      byteLength: 1_000_000,
      width: 1280,
      height: 720,
      durationMs: 10_000,
      position: 0,
    },
    {
      mediaId: "00000000-0000-4000-8000-000000000102",
      kind: "audio",
      mimeType: "audio/mpeg",
      url: AUDIO_URL,
      thumbnailUrl: null,
      byteLength: 500_000,
      width: null,
      height: null,
      durationMs: 10_000,
      position: 1,
    },
  ],
  links: [],
  userTags: [],
  capsules: [],
};

const audioMoment = {
  ...moment,
  momentId: AUDIO_MOMENT_ID,
  displayId: "browser-audio-policy",
  description: "A second card covering the audio preview branch.",
  previewMedia: {
    mediaId: "00000000-0000-4000-8000-000000000102",
    kind: "audio",
    mimeType: "audio/mpeg",
    url: AUDIO_URL,
    thumbnailUrl: null,
    width: null,
    height: null,
  },
};

const imageMoment = {
  ...moment,
  momentId: IMAGE_MOMENT_ID,
  displayId: "browser-image-loading-policy",
  description: "A gallery fixture whose R2 originals must load only after a choice.",
  sourceMediaCount: 8,
  mediaCount: 8,
  previewMedia: {
    mediaId: "00000000-0000-4000-8000-000000000201",
    kind: "image",
    mimeType: "image/jpeg",
    url: IMAGE_URLS[0],
    thumbnailUrl: null,
    width: 1600,
    height: 1200,
  },
  media: [
    ...IMAGE_URLS.map((url, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(201 + index).padStart(12, "0")}`,
      kind: "image",
      mimeType: "image/jpeg",
      url,
      thumbnailUrl: null,
      byteLength: 1_200_000 + index,
      width: 1600,
      height: 1200,
      durationMs: null,
      position: index,
    })),
    {
      mediaId: "00000000-0000-4000-8000-000000000207",
      kind: "image",
      mimeType: "image/heic",
      url: HEIC_URL,
      thumbnailUrl: null,
      byteLength: 4_000_000,
      width: 3024,
      height: 4032,
      durationMs: null,
      position: 6,
    },
    {
      mediaId: "00000000-0000-4000-8000-000000000208",
      kind: "image",
      mimeType: "image/x-adobe-dng",
      url: DNG_URL,
      thumbnailUrl: null,
      byteLength: 18_000_000,
      width: 3024,
      height: 4032,
      durationMs: null,
      position: 7,
    },
  ],
  links: [
    {
      linkId: "00000000-0000-4000-8000-000000000301",
      title: "Archived link image",
      description: null,
      url: "https://example.com",
      imageUrl: IMAGE_URLS[5],
      createdOn: "2026-07-23T00:00:00.000Z",
    },
  ],
  capsules: [
    {
      capsuleId: 1,
      externalId: null,
      title: "Archived capsule image",
      description: null,
      imageUrl: IMAGE_URLS[5],
      url: null,
      owner: null,
      createdOn: "2026-07-23T00:00:00.000Z",
    },
  ],
};

const heicCardMoment = {
  ...moment,
  momentId: "00000000-0000-4000-8000-000000000004",
  displayId: "browser-heic-card-policy",
  mediaCount: 1,
  sourceMediaCount: 1,
  previewMedia: {
    mediaId: "00000000-0000-4000-8000-000000000207",
    kind: "image",
    mimeType: "image/heic",
    url: HEIC_URL,
    thumbnailUrl: null,
    width: 3024,
    height: 4032,
  },
};

const dngCardMoment = {
  ...heicCardMoment,
  momentId: "00000000-0000-4000-8000-000000000005",
  displayId: "browser-dng-card-policy",
  previewMedia: {
    ...heicCardMoment.previewMedia,
    mediaId: "00000000-0000-4000-8000-000000000208",
    mimeType: "image/x-adobe-dng",
    url: DNG_URL,
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/meta", async (route) => {
    await route.fulfill({
      json: {
        snapshotId: "2026-07-02-v1",
        snapshotAt: "2026-07-02T00:00:00.000Z",
        counts: { drops: 1, tokens: 1, owners: 1, artworks: 1 },
        years: [2026],
      },
    });
  });
});

test("Moments cards never mount or request deferred media originals", async ({ page }) => {
  const mediaRequests = await interceptMedia(page);
  await page.route("**/api/moments?*", async (route) => {
    await route.fulfill({
      json: {
        snapshotId: "moments-2026-07-23-v1",
        items: [moment, audioMoment, imageMoment, heicCardMoment, dngCardMoment],
        nextCursor: null,
      },
    });
  });

  await page.goto("/moments");
  await expect(page.getByRole("heading", { name: "Latest public memories" })).toBeVisible();
  await expect(page.getByText("Open this Moment to load the video")).toBeVisible();
  await expect(page.getByText("Open this Moment to load the audio")).toBeVisible();
  await expect(
    page.getByText("Open this Moment to choose whether to load the original image"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Archived HEIC file Download original" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Archived DNG file Download original" }),
  ).toBeVisible();
  await expect(page.locator("video, audio")).toHaveCount(0);
  await expect(page.locator(`img[src="${HEIC_URL}"], img[src="${DNG_URL}"]`)).toHaveCount(0);
  expect(mediaRequests).toEqual([]);
});

test("Moment detail mounts players only after an explicit click", async ({ page }) => {
  const mediaRequests = await interceptMedia(page);
  await page.route(`**/api/moments/${MOMENT_ID}`, async (route) => {
    await route.fulfill({ json: moment });
  });

  await page.goto(`/moments/${MOMENT_ID}`);
  const videoButton = page.getByRole("button", { name: "Archived video Load video controls" });
  const audioButton = page.getByRole("button", { name: "Archived audio Load audio controls" });
  await expect(videoButton).toBeVisible();
  await expect(audioButton).toBeVisible();
  await expect(page.locator("video, audio")).toHaveCount(0);
  expect(mediaRequests).toEqual([]);

  await videoButton.click();
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute("preload", "none");
  expect(await video.evaluate((element: HTMLVideoElement) => element.autoplay)).toBe(false);
  await expect(page.locator("audio")).toHaveCount(0);
  expect(mediaRequests).toEqual([]);

  await audioButton.click();
  const audio = page.locator("audio");
  await expect(page.locator("video, audio")).toHaveCount(2);
  await expect(audio).toHaveAttribute("preload", "none");
  expect(await audio.evaluate((element: HTMLAudioElement) => element.autoplay)).toBe(false);
  expect(mediaRequests).toEqual([]);

  await video.evaluate((element: HTMLVideoElement) => element.load());
  await audio.evaluate((element: HTMLAudioElement) => element.load());
  await expect.poll(() => [...mediaRequests].sort()).toEqual([AUDIO_URL, VIDEO_URL].sort());
});

test("Moment detail loads archived images individually or in a bounded batch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mediaRequests = await interceptMedia(page);
  await page.route(`**/api/moments/${IMAGE_MOMENT_ID}`, async (route) => {
    await route.fulfill({ json: imageMoment });
  });

  await page.goto(`/moments/${IMAGE_MOMENT_ID}`);
  await expect(page.getByText("Images stay unloaded until you choose")).toBeVisible();
  await expect(page.getByText("0 of 6 loaded")).toBeVisible();
  await expect(page.locator('img[src^="https://media.poap.in/"]')).toHaveCount(0);
  expect(mediaRequests).toEqual([]);

  await page.getByRole("button", { name: /Archived image 1 Load original image/ }).click();
  await expect(page.getByText("1 of 6 loaded")).toBeVisible();
  await expect(page.locator('img[src^="https://media.poap.in/"]')).toHaveCount(1);
  await expect.poll(() => mediaRequests).toEqual([IMAGE_URLS[0]]);

  await page.getByRole("button", { name: "Load next 4 images" }).click();
  await expect(page.getByText("5 of 6 loaded")).toBeVisible();
  await expect(page.locator('img[src^="https://media.poap.in/"]')).toHaveCount(5);
  await expect.poll(() => [...mediaRequests].sort()).toEqual(IMAGE_URLS.slice(0, 5).sort());

  await expect(page.getByRole("link", { name: /Download original HEIC file/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Download original DNG file/ })).toBeVisible();
  await expect(page.locator(`img[src="${HEIC_URL}"], img[src="${DNG_URL}"]`)).toHaveCount(0);
  expect(mediaRequests).not.toContain(HEIC_URL);
  expect(mediaRequests).not.toContain(DNG_URL);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("the production CSP permits only the dedicated media origin for players", async () => {
  const headers = await readFile("public/_headers", "utf8");
  const policy = headers
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("Content-Security-Policy:"));
  const mediaDirectives = policy
    ?.split(":")
    .slice(1)
    .join(":")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.startsWith("media-src"));
  expect(mediaDirectives).toEqual(["media-src https://media.poap.in"]);
});

async function interceptMedia(page: Page) {
  const requests: string[] = [];
  await page.route("https://media.poap.in/**", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.endsWith(".jpg")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "image/gif" },
        body: Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64"),
      });
      return;
    }
    await route.fulfill({
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": "1",
        "Content-Range": "bytes 0-0/1",
        "Content-Type": route.request().url().endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
      },
      body: Buffer.from([0]),
    });
  });
  return requests;
}

function mediaUrl(character: string, extension: string) {
  const digest = character.repeat(64);
  return `https://media.poap.in/snapshots/moments-2026-07-23-v1/moments/original/sha256/${digest.slice(0, 2)}/${digest}.${extension}`;
}
