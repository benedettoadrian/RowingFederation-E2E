# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are UTC-3 (project local time). Entries are grouped under `[Unreleased]`
until merged, at which point the section is retitled with the merge date.

## [Unreleased]

### Fixed
- `docker-compose.e2e.yml` referenced `minio/minio`/`minio/mc` on Docker Hub,
  which no longer allows anonymous pulls of those images ("pull access
  denied") — `npm run stack:up` was completely broken. Switched to MinIO's
  official `quay.io` mirror (same images/tags, drop-in replacement). No
  production impact: no production repo references these images — MinIO is
  only the local stand-in for Cloudflare R2 in this stack.

---

_Earlier history predates this changelog — see `git log`._
