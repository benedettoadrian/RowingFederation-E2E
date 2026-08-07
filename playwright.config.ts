import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./fixtures/lib/config.js";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry everywhere, not just CI: a Serializable "transaction
  // conflict" that survives withConflictRetry's own 30s budget is a real,
  // documented, transient infra condition (Postgres SSI abort under
  // concurrent writes), not a correctness bug — retrying the whole test
  // once is the standard, honest way to absorb that, on top of (not
  // instead of) reducing the actual write pressure below.
  retries: 1,
  // Local workers used to be uncapped-ish (4, vs CI's already-safer 2) on
  // the theory that "the isolated files handle their own contention." That
  // theory broke: even inside the isolated project, different FILES still
  // ran concurrently across workers (fullyParallel:false only serializes
  // WITHIN one file — see chromium-serial's own `workers: 1` below for the
  // fix that project needed), and outside it, more workers is directly more
  // concurrent connections hammering one lightweight e2e-postgres
  // container — the real root cause of the sustained (not momentary)
  // Postgres SSI "transaction conflict" bursts on crew_entry_results /
  // referee_work_assignments that withConflictRetry has to absorb. Matching
  // CI's value everywhere reduces the actual write pressure suite-wide
  // instead of only reactively isolating the next file that flakes.
  workers: 2,
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
      // `fullyParallel: false` only serializes tests WITHIN a single file —
      // different files in this same project (e.g. results.spec.ts and
      // master-handicap.spec.ts, both isolated here specifically to avoid
      // contending with EACH OTHER on crew_entry_results) still ran on
      // separate workers concurrently, defeating the whole point. `workers:
      // 1` is Playwright's documented per-project override for exactly
      // this: a project whose tests "share state and therefore cannot be
      // executed in parallel." Confirmed the gap once fullyParallel:false
      // alone still let master-handicap.spec.ts hit a live Serializable
      // conflict from another concurrently-running file in this project.
      workers: 1,
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
