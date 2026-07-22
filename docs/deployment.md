# Deployment

The public target is `poap.in` on Cloudflare Workers, with original artwork at
`media.poap.in`. This checklist
keeps resource provisioning, data publication, and code deployment explicit.

## Prerequisites

- Node.js 22 or newer and npm
- a Cloudflare account with the `poap.in` zone
- a narrowly scoped Cloudflare API token or an authenticated Wrangler session
- permission to create Workers, two D1 databases, an R2 bucket, and the custom
  domain

Review current Cloudflare limits and pricing before importing production data.
The repository deliberately does not promise that a particular plan will fit an
unknown archive size.

## Install and authenticate

```bash
npm ci
npx wrangler login
```

For CI deployment, use a scoped token in the CI secret store. Never commit
tokens, account IDs that are intended to remain private, `.dev.vars`, or
downloaded data.

## Provision once

Create the named resources in the intended Cloudflare account:

```bash
npx wrangler d1 create poapin-archive-catalog
npx wrangler d1 create poapin-archive-holdings
npx wrangler r2 bucket create poapin-archive
```

Copy the returned D1 database IDs into the matching entries in
`wrangler.jsonc`. The checked-in IDs identify Glory Lab's production resources;
forks must replace them with databases in their own Cloudflare account.

Confirm that `poap.in` belongs to a zone in the same account. Wrangler is
configured to attach it as a Worker custom domain. Bind the R2 bucket's custom
domain to `media.poap.in`; media-domain routing remains
an explicit launch task; do not publish `MEDIA_BASE_URL` until it resolves to
the intended R2-serving path. Keep the bucket's public `r2.dev` development URL
disabled so artwork is exposed only through the reviewed custom domain.

## Generate binding types

After any binding change:

```bash
npm run cf-typegen
npm run typecheck
```

Commit generated type changes together with the binding change.

## Apply migrations

The numbered schema is pre-release while the complete source ZIP is still under
review. Validate every migration locally before remote application:

```bash
npx wrangler d1 migrations apply CATALOG_DB --local
npx wrangler d1 migrations apply HOLDINGS_DB --local
npx wrangler d1 migrations apply CATALOG_DB --remote
npx wrangler d1 migrations apply HOLDINGS_DB --remote
```

Never edit an already-applied migration. Every schema pull request must include
forward validation and rollback guidance; a rollback may require a new forward
migration.

Synthetic development rows live under `fixtures/`, outside the migration
chain. `npm run db:setup:local` applies them only to the local databases. Never
run a fixture file with `--remote`.

## Import a staged snapshot

Follow [Data import](data-import.md). A deployable code build is not evidence
that the archive data is complete. Before activation, verify:

- the source checksum and importer commit;
- catalog, holdings, rejected-row, and media totals;
- representative indexed queries and exports;
- that every required R2 object is readable from the intended media route; and
- that the snapshot's rights, attribution, and known-limitations notices exist.

Use the checked-in [offline importer](../tools/archive-import/README.md) and
[R2 media uploader](../tools/r2-media-upload/README.md); retain their reports as
release artifacts.

## Validate the build

```bash
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` includes a Wrangler dry-run. Inspect its bundle and binding
output; verify that it references the intended account resources and snapshot.

## Deploy the public site

```bash
npm run deploy
```

After deployment, verify at least:

- the home page and static assets;
- `/api/meta` and one page each of browse and address results;
- an empty result and an invalid request;
- image success and fallback behavior;
- JSON and CSV export metadata;
- cache headers and repeated-request behavior; and
- observability without secrets, response bodies, or unnecessary address data.

Record the Worker version, Git commit, snapshot ID, migration state, and smoke
test result in the release notes.

## Cache and rollback

Public caches must be namespaced by snapshot ID. Cache content is disposable and
must never be the only copy of a record or image.

Keep the previous code version and immutable snapshot available during the
rollback window. To roll back, redeploy the last known-good code and snapshot
configuration, then repeat the smoke tests. Do not delete the failed snapshot's
D1 rows or R2 objects during an incident; investigate and clean up separately.

## Public launch readiness gate

A public launch requires documented answers for:

- measured Worker CPU, D1 rows read, R2 operations, and cache effectiveness;
- rate limits and abuse behavior for search and address export;
- data provenance, artwork rights, attribution, correction, and takedown flow;
- log fields, sampling, access, and retention;
- backup, restore, rollback, and snapshot retention drills; and
- an operator runbook for D1 overload, R2/media failure, and bad imports.
