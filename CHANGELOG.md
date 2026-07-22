# Changelog

All notable changes to POAPin Archive will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases will follow [Semantic Versioning](https://semver.org/) once a
stable public contract exists.

## [Unreleased]

### Added

- Public archive browser at [poap.in](https://poap.in) for the fixed
  `2026-07-02-v1` snapshot.
- Indexed D1 catalog and holdings queries, exact-address CSV/JSON exports, and
  snapshot-versioned Workers Cache responses.
- Immutable original artwork delivery from R2 at
  [media.poap.in](https://media.poap.in), with a verified 73,795-object initial
  synchronization and UI fallbacks for source-missing artwork.
- Authenticated, resumable R2 import tooling for large archive uploads.
- Deterministic, two-pass POAP Compass Collections capture with schema evidence,
  media quarantine, checksums, a portable SQLite backup, and a restorable
  application-level archive of anonymously reachable data.
- Referenced-drop enrichment for 26,004 Collection-linked drops, including
  per-chain and anonymous activity aggregates plus a deterministic 26,550-object
  media proof covering 18,533 fixed-Archive reuses, 7,331 new drop originals,
  and 686 Collection-branding objects. A second remote pass integrity-verified
  every object with zero failures before the snapshot-scoped D1 was activated.
- A separately gated Collections D1 model with fail-closed remote loading,
  bounded collection browsing, detail, item, and segmented export APIs.
- A responsive Collection Hub with search and filters, Collection profile and
  relationship views, public owner and approved-suggestion attribution, and
  portable segmented export controls.
- Open-source contribution, conduct, security, licensing, architecture,
  deployment, and data-import documentation.
