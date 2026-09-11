import { defineConfig } from "@playwright/test";
import { LOCAL_APP_URL } from "./config.js";

/**
 * Dedicated Playwright config for the "replicate a competition date"
 * simulation (plan.md) — deliberately separate from the repo's root
 * playwright.config.ts, which targets the disposable Docker E2E stack.
 * These specs drive the real LOCAL DEV frontend/backend/DB instead, run
 * strictly sequentially (each phase depends on state the previous phase
 * created), and are never picked up by `npx playwright test` at the repo
 * root or by run-all-tests.sh.
 *
 * Run: npx playwright test --config=scripts/e2e-simulations/playwright.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: /phase.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  // Full visual record of every phase run, on request — each `test(...)`
  // block (one per fase, e.g. "Fase 6.2", "Fase 6.3") gets its own .webm
  // under test-results/<test name>/video.webm, so reviewing one phase never
  // means scrubbing through the whole simulation.
  outputDir: "./output/test-results",
  use: {
    baseURL: LOCAL_APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "on",
  },
});
