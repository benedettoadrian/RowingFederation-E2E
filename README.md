# RowingFederation-E2E

Cross-repo E2E integration suite (frontend + backend + Postgres) for Sistema Agazzi.
Real production builds of [RowingFederation-Backend](../RowingFederation-Backend) and
[RowingFederation-Frontend](../RowingFederation-Frontend), a disposable test Postgres, and a
deterministic OCR stub (not the real EasyOCR service) wired together with Playwright driving
an actual browser against the actual UI.

Full test plan and phased rollout: see the `fur-e2e-integration-test-plan` memory (Claude
workspace memory, not in this repo).

## Requirements

Checked out as a sibling of `RowingFederation-Backend` and `RowingFederation-Frontend`
(same parent directory) — the compose file builds them via relative `context: ../...`, same
convention the Backend repo's own `docker-compose.yml` already uses for
`../RowingFederation-OCR`.

- Docker + Docker Compose
- Node 20+

## Running locally

```bash
npm install
npm run stack:up      # builds + starts postgres-test, ocr-stub, backend, frontend
npm run seed          # bootstraps 1 admin directly in Postgres, creates the other
                       # 10 role-users + 2 clubs through the real API
npx playwright install chromium
npm run test:e2e:tier0
npm run stack:down    # tears everything down, including the postgres volume
```

Ports (offset from the normal dev stack so both can run at once):
Postgres `5433`, Backend `3001`, OCR stub `8002`, Frontend `5174`.

Tier 1 (`npm run test:e2e:tier1`, or `npm run test:e2e` for everything) covers negative/security
cases too slow or too flaky-under-parallelism for PR gating — run nightly, not on every push.
`--workers=1` is recommended for tier1: the OCR circuit breaker test relies on process-wide
singleton state that a parallel worker's unrelated successful OCR call can reset.

**Rate limiting resets on stack restart, not on reseed.** The E2E stack overrides
`RATE_LIMIT_MAX_REQUESTS`/`LOGIN_RATE_LIMIT_MAX_OVERRIDE` to `1000`/15min (real prod: 500 and
10 respectively) — generous, but repeated full-suite runs against the same long-lived backend
container within a 15-minute window (e.g. iterating locally without `stack:down`) can still
exhaust it and produce `429 RATE_LIMIT_EXCEEDED`/`LOGIN_RATE_LIMIT_EXCEEDED`. Not a product bug
— if you hit it locally, `npm run stack:down && npm run stack:up && npm run seed` clears it. CI
runs always start from a fresh container so this doesn't occur there.

**Timing (2026-07-10, full stack incl. build, M-series Mac, fresh DB):** 97 tier0 tests in
~19s wall time; 3 tier1 tests in ~1.5s (`--workers=1`). Comfortably fast enough that nothing
needed to be demoted from tier0 to tier1 for speed — the split is purely about flakiness/known-
gap isolation, not runtime budget. Re-measure if the suite grows substantially.

## Adding a new test

1. Pick (or create) the matching `tests/<domain>/` folder — mirrors the backend module
   layout (`athletes/`, `clubs/`, `competitions/`, `news/`, `users/`, `security-rbac/`, `i18n/`,
   `audit/`).
2. Prefer `fixtures/lib/api.ts`'s `api.get/post/patch/put/delete/postMultipart` over UI
   interaction for setup/assertions — only drive the actual browser (`fixtures/auth.ts`'s
   `loginAs(page, role)`) when the thing under test is genuinely UI behavior (a form, a
   redirect, a rendered page). Most of this suite is API-level for speed and determinism; a
   handful of tests (`tests/auth/login.spec.ts`, `tests/i18n/locale-render.spec.ts`) are
   UI-level on purpose.
3. Reuse `fixtures/lib/competitions.ts`'s `setupInscriptionFixtures`/
   `setupCompetitionDateFixtures` instead of hand-rolling club/pista/programa/event chains —
   most competition-domain tests need the same scaffolding.
4. Tag every test `@tier0` or `@tier1` in the test name (not a Playwright `tag` option — this
   suite uses `--grep` on the literal string). Default to `@tier0` unless the test is a known
   negative/security case that's slow, needs isolation from parallel workers, or documents a
   confirmed-but-deferred gap.
5. Random test data needs real entropy — this suite hit repeated collisions from short slices
   (`randomUUID().slice(0,3)` for club abbreviations, narrow day ranges for `CompetitionDate`,
   etc.) once fixture volume grew. Use `randomUUID()` in full or a wide range for anything with
   a DB-wide uniqueness constraint, not just a per-record-scoped one.
6. Don't assume a response shape — this suite found several real deviations from the obvious
   guess (`PATCH .../status` returns `{success,message}` with no `data`; audit logs are
   paginated under `data.auditLogs`, not a bare array; `entityType` is stored upper-cased).
   Confirm by reading the controller/DTO, not by guessing, and prefer a follow-up `GET` over
   trusting a write response's shape.
7. Run it against the real stack (`npm run seed` then the relevant `playwright test <file>`)
   at least twice on a fresh DB before considering it done — flakiness in this suite has always
   come from shared/singleton backend state or fixture collisions, both of which only show up
   under a real run, never under `tsc --noEmit`.

## Rotating the cross-repo CI token

`E2E_CROSS_REPO_PAT` (GitHub Actions secret, set individually on `RowingFederation-Backend`,
`RowingFederation-Frontend`, and this repo — no shared org secret, since Backend and
Frontend/E2E live under different GitHub owners) is a classic PAT with `repo` scope, used by
each repo's `e2e-smoke` CI job to check out the other two repos' `develop` branch. To rotate:
generate a new classic PAT (GitHub → Settings → Developer settings → Personal access tokens →
Tokens (classic)) with `repo` scope, then update the `E2E_CROSS_REPO_PAT` secret on all three
repos (Settings → Secrets and variables → Actions) — a token missing from any one of the three
breaks that repo's `e2e-smoke` job specifically, not the others.

## Known gaps documented, not fixed (deliberate — see full test plan for the decision record)

These are pinned by dedicated `KNOWN GAP`-named tests so a future change that silently starts
enforcing (or further breaking) them shows up as a failing/changed test, not a surprise:

- **Inscription conflict**: no backend check prevents the same athlete being entered in two
  events on the same competition date — `tests/competitions/inscription.spec.ts`.
- **Submission lock is cosmetic**: `isLocked` is set on confirm but never read by
  create/update/withdraw crew-entry use cases, and unlock is self-service by the club's own
  delegate, not admin-restricted — `tests/competitions/inscription.spec.ts`.
- **Document upload validation returns 500, not 400**: bad mimetype / oversized file never hit
  the existing (but unwired) `handleMulterError` — `tests/athletes/document-upload-validation.spec.ts`
  (`@tier1`).
- **Inscription window has no time check**: `inscriptionCloseAt` passing doesn't block
  creation; only the `status` field does, and that's cron-updated on a lag —
  `tests/competitions/inscription-window.spec.ts`.
- **`canRegisterAthletes` DTO field is misleading for DEBTOR clubs**: says `true`, but a DEBTOR
  club's own delegate is actually blocked (400) from creating an athlete —
  `tests/clubs/club-status.spec.ts`.

## Known issues found while building this

1. **`DropdownMenuItem` (Topbar.tsx logout item) `data-testid` doesn't reach the DOM. Not
   fixed — investigated exhaustively, root cause not found.** Added
   `data-testid="logout-menu-item"` to the logout `DropdownMenuItem` in
   `RowingFederation-Frontend/src/components/layout/Topbar.tsx`; confirmed via
   `page.evaluate()` + `querySelector` against the live browser DOM that the attribute was
   absent, even though the sibling `user-menu-trigger` testid on the same component works
   fine. Traced through all four layers of Radix's prop-spreading/merging chain
   (`@radix-ui/react-dropdown-menu` → `-menu` → `-roving-focus` → `-primitive`/`-slot`) — the
   `mergeProps()` logic looks correct in static analysis (should let a caller-supplied
   `data-testid` survive the `asChild`/Slot merge), ruled out Docker build caching (full
   `--no-cache` rebuild + `docker builder prune -af`, still absent), and found no React
   console warnings. The exact mechanism was never identified. **Pragmatic resolution:**
   removed the ineffective attribute from `Topbar.tsx` (kept the source clean rather than
   leaving a misleading unused testid), and standardized on role-based Playwright locators
   for Radix menu items instead — `tests/auth/login.spec.ts`'s logout test uses
   `getByRole("menuitem", { name: "Cerrar sesión", exact: true })`. Adopt this pattern for any
   future Radix `DropdownMenuItem`/`MenuItem` test hooks rather than retrying `data-testid`.

## Fixed while building this (already applied to the app repos)

- **OCR↔Backend response contract mismatch.** `RowingFederation-Backend`'s
  `ocr-http-client.service.ts` used to parse `data.review_reason` /
  `data.extracted_document_number` / `data.extracted_expiration_date` (flat snake_case) from
  the OCR service's `/extract-document` response. The real OCR service
  (`RowingFederation-OCR/services/document_validator.py`) actually returns `reviewReason`
  (camelCase) and a nested `extracted: {documentNumber, expirationDate, ...}` object — never
  the snake_case flat fields the backend used to read, so `reviewReason` and the extracted
  document number/expiration date were silently `undefined` in production. This stub
  (`ocr-stub/server.ts`) deliberately mirrors the real contract, which is how the E2E work
  surfaced this. Fixed in `ocr-http-client.service.ts` to parse the real shape, with a new
  regression suite (`tests/unit/.../ocr-http-client.service.spec.ts`, 3/3 passing) that also
  asserts the old snake_case fields are never read even if present.
- **`NODE_ENV=production` hard-requires Cloudflare R2 — now satisfied via MinIO.**
  `shared.dependencies.ts` fails fast (by design) if `NODE_ENV==="production"` and R2 env vars
  are missing. Rather than working around this with `NODE_ENV=test` (which also silently
  disabled the login rate limiter, see next item), added `CLOUDFLARE_R2_ENDPOINT_OVERRIDE` /
  `CLOUDFLARE_R2_FORCE_PATH_STYLE` to `env.config.ts` + `cloudflare-r2-storage.service.ts`
  (test-stack-only, never set in real deployments), and added `minio` + `minio-init` services
  to `docker-compose.e2e.yml`. The backend now runs `NODE_ENV: production` for real here.
- **Login rate limiter (10 req/15min/IP, production-only) blocked the login suite.**
  Surfaced once the stack ran true production mode: `login.spec.ts` logs in as all 11 fixture
  roles from a single IP in one run, which exceeds the real 10/15min login limiter
  (`rate-limit.middleware.ts`) — correct behavior for real prod, not a bug. Added an explicit
  `LOGIN_RATE_LIMIT_MAX_OVERRIDE` env var (optional, unset in real deployments, so production
  keeps enforcing 10/15min) and set it to `1000` in this compose file only. 12/12 tests in
  `login.spec.ts` pass against the resulting true-production + MinIO stack.
- `RowingFederation-Frontend/next.config.ts`: CSP `connect-src`/`img-src` had
  `https://api.fedururemo.com` hardcoded, so any other production-mode build (this one, a
  staging deploy, a preview) pointing `NEXT_PUBLIC_API_URL` elsewhere was silently blocked by
  its own CSP. Now derived from `NEXT_PUBLIC_API_URL` at build time — identical output for the
  real prod deploy, since that's exactly what `NEXT_PUBLIC_API_URL` is there.
- `RowingFederation-Frontend/src/features/auth/components/LoginForm.tsx`: "Forgot password?"
  link text was hardcoded English in an otherwise fully-translated (ES/EN/PT) app. Added
  `auth.forgotPasswordLink` to `messages/{es,en,pt}.json` and wired it.
