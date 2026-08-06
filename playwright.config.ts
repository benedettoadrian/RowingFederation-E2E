import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./fixtures/lib/config.js";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Uncapped local workers (this machine: 10 cores) throws that many
  // concurrent connections at a single lightweight e2e-postgres container —
  // real root cause of the sustained (not momentary) Postgres SSI
  // "transaction conflict" bursts on crew_entry_results that
  // withConflictRetry has to absorb. Capping concurrency here reduces the
  // actual write pressure instead of just inflating retry budgets to
  // outlast an unbounded one.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // withConflictRetry (fixtures/lib/api.ts) can legitimately wait up to 30s
  // on a Serializable "transaction conflict" before giving up — the default
  // 30s was too tight even for a single such call plus normal setup.
  timeout: 45_000,
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      // ocr-http-client.service.ts's circuit breaker is in-process singleton
      // state on the backend, shared across the whole test run — any other
      // file's concurrent successful OCR call landing between this test's 5
      // forced failures resets the counter via recordSuccess(). Isolating it
      // in its own project + `dependencies` below guarantees Playwright runs
      // it to completion with nothing else in flight, instead of relying on
      // luck/retries.
      name: "chromium-serial",
      // ocr-circuit-breaker.spec.ts: see comment above. locale-render.spec.ts's
      // public-page tests do real SSR data-fetching against the backend on
      // every request (live competition status, medal counts, club count,
      // news, history) — queued behind ~190 concurrent API-hammering tests
      // in the main project, first-paint can blow well past the 30s test
      // timeout. results.spec.ts and master-handicap.spec.ts write directly
      // and repeatedly to crew_entry_results (upsertResult's Serializable
      // transaction) — withConflictRetry's jittered wall-clock budget
      // (fixtures/lib/api.ts) cut the failure rate a lot but didn't zero it
      // out under this project's own peak concurrent load; isolating these
      // files removes that contention outright instead of retrying through
      // it. referee_work_assignments is hit hard by BOTH
      // referee-work-assignments.spec.ts (the dedicated writer) AND
      // live-operations.spec.ts (assignPost is called from nearly every
      // test in that large file — isolating the former alone still left
      // enough internal same-file parallelism in the latter to exhaust
      // withConflictRetry's full 30s budget on its own). None of this is
      // an app bug; all six just need to run without that contention.
      testMatch: [
        /ocr-circuit-breaker\.spec\.ts/,
        /locale-render\.spec\.ts/,
        /competitions\/results\.spec\.ts/,
        /competitions\/master-handicap\.spec\.ts/,
        /competitions\/master-handicap-world-rowing\.spec\.ts/,
        /competitions\/referee-work-assignments\.spec\.ts/,
        /competitions\/live-operations\.spec\.ts/,
      ],
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: [
        /ocr-circuit-breaker\.spec\.ts/,
        /locale-render\.spec\.ts/,
        /competitions\/results\.spec\.ts/,
        /competitions\/master-handicap\.spec\.ts/,
        /competitions\/master-handicap-world-rowing\.spec\.ts/,
        /competitions\/referee-work-assignments\.spec\.ts/,
        /competitions\/live-operations\.spec\.ts/,
      ],
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["chromium-serial"],
    },
  ],
});
