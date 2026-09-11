import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * Logs in through the real login form (data-testid selectors, same as
 * fixtures/auth.ts's loginAs). These simulation scripts switch between
 * several role logins on the SAME page within one test (delegate ->
 * ADMIN -> REGATTA_COMMISSION -> REFEREE), unlike the main suite's fixtures
 * (one role per isolated test). A still-valid session (auth store persists
 * to localStorage, not just the auth cookie) makes /login redirect straight
 * back to /dashboard without ever showing the form — clear both before
 * navigating so every call is a real, fresh login as the requested user.
 */
export async function simLogin(page: Page, email: string, password: string): Promise<void> {
  // Observed twice across ~163 role switches: the login form occasionally
  // never renders within 10s on the first attempt (dev-server hot-reload
  // hiccup or a slow client-side nav) — a plain retry of the whole
  // sequence has resolved it both times, so it's a real if rare flake, not
  // a design issue with the sequence itself.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.context().clearCookies();
      await page.goto("/es/login");
      await page.evaluate(() => localStorage.clear()).catch(() => {});
      await page.goto("/es/login");
      await page.waitForLoadState("networkidle");
      // Wait for the form to be interactive before filling — otherwise a
      // fill+click landing before React hydrates can fall through to the
      // raw <form>'s native submit (GET, credentials in the query string)
      // instead of the JS handler.
      await page.getByTestId("login-submit").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await page.waitForURL(/\/es\/dashboard/, { timeout: 15_000 });
      return;
    } catch (err) {
      lastError = err;
      console.log(`  simLogin attempt ${attempt} failed for ${email}, retrying...`);
    }
  }
  throw lastError;
}

/**
 * Running state shared across phase*.spec.ts files (competition date id,
 * per-club delegate credentials, saved verification codes, etc.) — each
 * phase reads what earlier phases wrote and appends its own results. Lets
 * the simulation be resumed/re-run phase by phase instead of needing one
 * giant all-or-nothing script.
 */
export interface SimulationState {
  competitionDateId?: string;
  competitionDateName?: string;
  delegatesByClubId?: Record<string, { email: string; wasCreated: boolean; displacedUserId?: string }>;
  regattaCommissionEmail?: string;
  refereeEmail?: string;
  submissionCodesByClubId?: Record<string, string>;
  [key: string]: unknown;
}

const STATE_PATH = new URL("../output/simulation-state.json", import.meta.url);

export function readState(): SimulationState {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

export function writeState(patch: Partial<SimulationState>): SimulationState {
  const current = readState();
  const next = { ...current, ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}
