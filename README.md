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
