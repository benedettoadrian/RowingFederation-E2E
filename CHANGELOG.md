# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are UTC-3 (project local time). Entries are grouped under `[Unreleased]`
until merged, at which point the section is retitled with the merge date.

## [Unreleased]

### Added
- `tests/regulations/regulations.spec.ts`: coverage for the new institutional
  regulations-by-article module (see sibling Backend/Frontend CHANGELOGs) — a
  brand-new article stays invisible on the public feed until published;
  publishing a new article at an existing position shifts the sibling's
  number without bumping its version; editing a published article creates a
  new version and supersedes the old one at the same number; a second draft
  is rejected while one is in progress; derogating hides an article entirely
  from the public feed (editors still see it); reordering shifts every
  article in between atomically; and REFEREE/CLUB_DELEGATE can read but not
  manage, while REGATTA_COMMISSION/DIRECTOR_ROLES can. Ran green against the
  full `chromium-serial` project (66/66) with zero regressions elsewhere.
- `tests/athletes/document-expiry-config.spec.ts`: coverage for the new
  `GET/PUT /athletes/document-expiry-config` endpoint (configurable
  document-expiry warning window, see sibling Backend/Frontend
  CHANGELOGs) — GET defaults to 20 days, REGATTA_COMMISSION can update it
  and the change is reflected in `/athletes/expiring-documents`'s new
  `thresholdDays` field (both the implicit default and an explicit
  `?daysAhead=` override), CLUB_DELEGATE is rejected (403) from writing
  it, and out-of-range values (0, 400) are rejected (400). Resets the
  config back to its original value in a `finally` block — it's global
  singleton state shared across the whole E2E run.
- `ocr-stub/server.ts`: new `/detect-face` route mirroring the real OCR
  service's new endpoint — defaults to `faceDetected: false`, returns a
  fixed bounding box when the uploaded filename contains `FACEDETECTED`
  (same magic-marker control pattern as the existing `OCRFAIL`/`BADIMG`
  markers).
- `tests/athletes/create-athlete.spec.ts`'s existing profile-photo test
  extended to exercise the real Backend -> OCR `/detect-face` call over
  the Docker network end-to-end (not mocked): the synthetic checkerboard
  fixture (`fixtures/lib/photo.ts`) has no real face, so `faceDetected:
  false` is the deterministic, correct outcome — asserts the stored photo
  reaches storage byte-for-byte unchanged, proving the fail-open path
  actually ran rather than just that the upload "succeeded" vacuously. A
  synthetic image Haar Cascade reliably detects as a face isn't
  fabricable deterministically, so the "a face IS found and gets cropped"
  path is covered at the unit level instead (both repos' own test
  suites), not here.

**Verification**: full suite run clean (238 passed, 1 pre-existing flaky
test passed on retry — Postgres SSI contention, documented/unrelated) — see
note below on 1 unrelated pre-existing failure found while verifying.

---

## [2026-09-15]

### Added
- `tests/dashboards/dashboard-aggregations.spec.ts`: coverage for the new
  `GET /clubs/athlete-status-breakdown` endpoint — every club covered,
  alphabetical order, per-status counts sum to the total; and a
  CLUB_DELEGATE 403 rejection test mirroring the existing
  `activity-ranking` pattern.
- `docker-compose.e2e.yml`: `DOCUMENT_UPLOAD_RATE_LIMIT_MAX_OVERRIDE`
  env var for `e2e-backend` — the document-upload rate limiter had no
  override (unlike the login/public-form ones), so a full tier0+tier1
  Playwright run tripped real 429s mid-suite once fixture users uploaded
  more than 20 documents in one 15-min window. See Backend's own
  CHANGELOG for the corresponding code fix.
- `ocr-stub/server.ts`: new `OCRVLM` magic marker (documentNumber containing
  it) — `/extract-document` returns `MATCHED` with `extractionSource: "vlm"`,
  simulating RowingFederation-OCR's Fase 2 fallback tier resolving a
  document the fast EasyOCR pass alone couldn't. The stub never runs an
  actual model; it only needs to prove the Backend correctly threads
  `extractionSource` through to the audit trail — the real VLM's own
  accuracy is validated separately in RowingFederation-OCR's own test
  suite and CHANGELOG, against real production images.
- `tests/athletes/document-upload.spec.ts`: new test asserting an identity
  doc resolved via the `OCRVLM` marker gets audit-logged with
  `entityData.extractionEngine: "vlm"` on the `AthleteRequirements`
  `STATUS_CHANGE` entry.
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
