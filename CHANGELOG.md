# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are UTC-3 (project local time). Entries are grouped under `[Unreleased]`
until merged, at which point the section is retitled with the merge date.

## [Unreleased]

### Added
- `tests/competitions/swap-final-qualifier.spec.ts` (4 tests, 2026-09-26 —
  see sibling Backend/Frontend CHANGELOGs for the ADMIN final-qualifier
  swap feature): golden path (a non-qualifying boat promoted into the
  vacated Final lane, outgoing entry deleted, both heat entries left
  untouched) plus non-ADMIN 403, blocked once the final result is
  confirmed, and incoming entry already in a Final rejected. Minimal
  fixture: 1 heat series, 3 single-seat boats, auto-draw-final's
  `maxLanes: 2` (independent of the pista's real `maxLanes`, which only
  constrains sorteo/confirm's own lane assignment).
- `tests/competitions/official-program-banner.spec.ts` (2026-09-24 — see
  sibling Frontend CHANGELOG for the banner itself): absent before CLOSED,
  visible with the right name + CTA href on the public home page and every
  authenticated dashboard once CLOSED, gone again once IN_COMPETITION.
  Pins the fixture's date 5-24 days out (below the default fixture's
  30-day-plus random floor) to deterministically win the "nearest upcoming
  CLOSED date" comparison against other tests' fixtures.
- `tests/competitions/sorteo-qualification-note.spec.ts` (3 tests, 2026-09-24
  — see sibling Backend/Frontend CHANGELOGs for the per-event qualification
  note feature): write + persist-across-reload + clear-deletes-the-row
  round trip through the sorteo proposal UI, the read-only lock once a
  prueba's sorteo is confirmed, and the REGATTA_MANAGERS write guard
  (CLUB_DELEGATE gets 403).
- `tests/competitions/sorteo-final-to-heats.spec.ts` (3 tests, 2026-09-23 —
  see sibling Backend/Frontend CHANGELOGs for the manual "pasar a
  eliminatorias" feature): converting a direct final to heats splits it
  2/1 and persists real "A"/"B" series through `sorteo/confirm` (never
  "Final"); undoing a conversion restores the exact original final;
  program recalculation after close succeeds for a prueba manually
  confirmed as heat series even though `Event.hasHeats` stays false in the
  database (the regression this feature's backend fix targets). No drag
  simulation — convert/undo are plain button clicks, unlike the
  drag-and-drop sorteo tests elsewhere in this suite.
- `tests/competitions/sorteo-out-of-program.spec.ts` (6 tests, urgent
  federation directive 2026-09-23 — see sibling Backend/Frontend
  CHANGELOGs): rejects `outOfProgram` without `reviewMode` (403) and from a
  CLUB_DELEGATE even with `reviewMode` forged in the body (403); direct
  final places the out-of-program boat in the last lane, persisted through
  `sorteo/confirm`; heats spreads two out-of-program boats one per heat,
  each in the last lane of its heat; an out-of-program boat that finishes
  1st never scores CircuitPoints and 2nd place is re-ranked to 1st's points
  (against a real CIRCUIT championship, not mocked); and the review-mode
  inscription form's checkbox persists the flag end to end (real UI, no
  drag — the club-select interaction retries opening the dropdown up to
  30s, since Next.js hydration can lag behind SSR under full-suite
  concurrent load, causing a first click to land before the trigger is
  actually interactive).

- `tests/athletes/auto-inactivate-unengaged.spec.ts`: real end-to-end proof
  that finalizing a `CompetitionDate` (real HTTP status-transition flow,
  real referee auth) triggers the new auto-inactivate-unengaged-athletes
  rule (see sibling Backend CHANGELOG) — a `PENDING_APPROVAL` athlete with
  no participation flips to `INACTIVE` once the 2nd of 2
  `FINAL_RESULTS` dates finalizes. The rule's "last 2 dates" scope is
  global/shared system state, unsafe to assert deterministically against
  other tests' dates — both dates here are pinned via `dateOverrides.date`
  to year 4000+, safely beyond the ~1370-year random range
  `setupInscriptionFixtures` uses by default, guaranteeing these two are
  the system's most-recent FINAL_RESULTS dates regardless of what else is
  running. `setupInscriptionFixtures` gained a new opt-in
  `extraEventHasHeats` option (a 3rd, `hasHeats: true` event) for the
  inscription-summary heats coverage below — off by default, the ~20
  existing callers see the exact same 2-event program they always have.
- `tests/competitions/inscription-summary.spec.ts`: `GET .../inscription-summary`
  (see sibling Backend CHANGELOG) — per-club totals (rowers, boats, events),
  one event with exactly 1 entry, one with none, and one 9-entry event
  (`hasHeats: true`, 2 clubs) correctly computed as needing 2 heats via the
  real `SorteoService` formula. Also confirms only regatta-manager roles
  (not `CLUB_DELEGATE`) can call the endpoint.
- `tests/competitions/sorteo-heat-seeding.spec.ts`: end-to-end proof of the
  heat-seeding-by-historical-podium-position feature (see sibling
  Backend/Frontend CHANGELOGs) — builds a real PAST `FINAL_RESULTS` date
  where two club1 boats and one club2 boat finish 1st/3rd/2nd (`series`
  exactly `"Final"`, `resultCode: FINISHED`) in the same prueba, then
  re-inscribes the same 3 boats (same club + same athlete, 1x identity) plus
  filler entries into a CURRENT date to force the heats branch (pista
  `maxLanes: 6`, 8 entries → 2 heats). Confirms via real UI: ADMIN sees
  exactly 1 prueba-level seeding icon (redesigned mid-session from a
  per-boat icon to a single per-prueba one after the user reviewed it
  locally — see Backend/Frontend CHANGELOGs), and hovering it shows both
  clubs and both rank tiers in the hover card. A second test confirms
  `sorteo/preview` 403s a `CLUB_DELEGATE` — the same
  `requiresRegattaManager()` guard the icon's role-gating depends on.
  `setupInscriptionFixtures` now also returns `pistaId`/`programId` (needed
  to build the second, past competition date reusing the exact same
  `Event.id` — "same prueba" the feature keys off — via a second program
  attached to it, additive change, no existing callers affected). Ran green
  against a freshly-seeded stack alongside the full `@tier0` suite (59/59).
- `tests/competitions/novice-eligibility.spec.ts`: new case for the Backend
  bugfix (see sibling Backend CHANGELOG) — a Senior boat created and
  withdrawn BEFORE the competition date is officially closed no longer
  counts against an athlete's Novicio eligibility. Ran green against the
  full suite on a freshly-seeded stack: 254/254 tests.
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

### Fixed
- **`docker-compose.e2e.yml`, CI-breaking (2026-09-24)**: `quay.io/minio/minio`
  and `quay.io/minio/mc` (already the fallback after Docker Hub blocked
  anonymous pulls of the same images) stopped allowing anonymous pulls too,
  breaking every CI run and every fresh clone's local E2E stack. Confirmed at
  the registry-protocol level, not a transient rate limit — quay.io issues an
  anonymous token with `actions: []` for `minio/minio`. Switched to Adobe's
  S3Mock (`adobe/s3mock`, still freely pullable); `minio-init` (mc-based)
  replaced with `s3-init` (`curlimages/curl`, also freely pullable) — bucket
  creation is a plain unsigned `curl -X PUT`, since S3Mock enforces no auth
  on any request (no bucket-policy dance needed for the app's unsigned public
  download URLs either — S3Mock doesn't even support bucket policies, but
  doesn't need to). Verified against the real S3 operations
  `CloudflareR2StorageService` uses, and with a full clean stack rebuild +
  tier0 run (243/244 passed, 1 pre-existing drag-simulation flake unrelated
  to storage, passed on retry).
- `tests/competitions/sorteo-out-of-program.spec.ts` (2026-09-24): the
  review-mode inscription form test used `page.getByLabel(/Club/i)` — an
  unanchored regex that also matches every open dropdown option whose club
  name contains "Club" (e.g. "Club Audit f647ba6f"), causing a strict-mode
  violation once enough clubs accumulate across a full-suite run. This is
  what caused the divergent `push` vs `pull_request` CI outcome on the same
  commit — whichever run had more accumulated clubs at that point tripped
  the ambiguity. Fixed to `getByLabel("Club", { exact: true })`.

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
