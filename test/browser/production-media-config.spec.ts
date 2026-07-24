import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("production R2 CORS is read-only and limited to poap.in", async () => {
  const policy = JSON.parse(await readFile("config/r2-cors.json", "utf8"));

  expect(policy).toEqual({
    rules: [
      {
        allowed: {
          origins: ["https://poap.in"],
          methods: ["GET", "HEAD"],
        },
        exposeHeaders: ["Content-Length", "Content-Type", "ETag"],
        maxAgeSeconds: 86_400,
      },
    ],
  });
});

test("production CSP permits the browser to read only the archived media origin", async () => {
  const headers = await readFile("public/_headers", "utf8");
  const policy = headers
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith("Content-Security-Policy:"));

  expect(readDirective(policy, "connect-src")).toEqual(["'self'", "https://media.poap.in"]);
  expect(readDirective(policy, "img-src")).toEqual(["'self'", "https://media.poap.in", "data:"]);
  expect(readDirective(policy, "media-src")).toEqual(["https://media.poap.in"]);
});

function readDirective(policy: string | undefined, name: string): string[] | undefined {
  return policy
    ?.slice(policy.indexOf(":") + 1)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
    ?.split(/\s+/u)
    .slice(1);
}
