# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are UTC-3 (project local time). Entries are grouped under `[Unreleased]`
until merged, at which point the section is retitled with the merge date.

## [Unreleased]

### Added
- `tests/athletes/document-identity-change.spec.ts` — E2E coverage for the
  Backend's document-identity-change confirmation gate (documentType/
  documentNumber edits): rejects the change without
  `confirmDocumentIdentityChange`, confirms it resets identity/consent/
  athlete-card to `PENDING_UPLOAD`, drops an ACTIVE athlete to
  `PENDING_APPROVAL`, and audits both the Athlete entry
  (`delegateConfirmedDocumentReset`) and each of the 3 reset
  AthleteRequirements entries (`reason: "document-identity-changed"`).
  Also covers a `documentType`-only change (same number). This was a gap:
  the confirmation gate had full Backend unit/integration coverage but no
  E2E test drove it through the real HTTP path.
- `tests/athletes/guardian-identity-doc.spec.ts` — new test for the
  centralized `GET /athletes/pending-reviews/guardian-doc` endpoint: a
  guardian document stuck in `REVIEW` shows up in the queue with the
  correct `guardianDoc` block, and drops out once approved.

### Fixed
- `docker-compose.e2e.yml` referenced `minio/minio`/`minio/mc` on Docker Hub,
  which no longer allows anonymous pulls of those images ("pull access
  denied") — `npm run stack:up` was completely broken. Switched to MinIO's
  official `quay.io` mirror (same images/tags, drop-in replacement). No
  production impact: no production repo references these images — MinIO is
  only the local stand-in for Cloudflare R2 in this stack.

---

_Earlier history predates this changelog — see `git log`._
