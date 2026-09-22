import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Real end-to-end proof of the "auto-inactivate unengaged athletes" rule
 * (see [[fur-three-improvements-2026-09-plan-pointer]]): finalizing a
 * competition date (real HTTP status-transition flow, real referee auth)
 * triggers AutoInactivateUnengagedAthletesUseCase, which flips a
 * PENDING_APPROVAL athlete with no participation to INACTIVE.
 *
 * The rule's "last 2 FINAL_RESULTS dates" scope is GLOBAL (see D1 in the
 * plan) — genuinely shared state across the whole system, which makes it
 * unsafe to assert deterministically against dates from OTHER tests running
 * in the same E2E stack. To keep this test self-contained and
 * non-flaky, both dates here are pinned via `dateOverrides.date` far into
 * the future (year 4000+) — safely beyond the ~1370-year random range
 * `setupInscriptionFixtures` uses for its own default dates — so these two
 * are guaranteed to be the two most-recent FINAL_RESULTS dates in the whole
 * system regardless of what else is running. The exhaustive coverage of the
 * selection/grace-period logic itself lives in the backend integration
 * tests (full control over exactly which dates exist); this file's job is
 * only to prove the real HTTP trigger fires.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function finalizeDate(
  adminToken: string,
  fx: { competitionDateId: string; referee: { email: string; password: string } }
) {
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_COMPETITION" },
    adminToken
  );
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "FINAL_RESULTS" },
    refereeToken
  );
}

test("finalizing the 2nd of 2 FINAL_RESULTS dates auto-inactivates an unengaged PENDING_APPROVAL athlete @tier1", async () => {
  const adminToken = await apiLoginAs("ADMIN");

  const farFutureYear = 4000 + Math.floor(Math.random() * 500); // unique-ish per run, still far beyond any other test's date
  const date1 = new Date(Date.UTC(farFutureYear, 0, 1)).toISOString();
  const date2 = new Date(Date.UTC(farFutureYear, 0, 2)).toISOString();

  const fx1 = await setupInscriptionFixtures(adminToken, {
    advanceToClosed: true,
    dateOverrides: { date: date1 },
  });
  const fx2 = await setupInscriptionFixtures(adminToken, {
    advanceToClosed: true,
    dateOverrides: { date: date2 },
  });

  // A PENDING_APPROVAL athlete with zero crew participation anywhere,
  // registered "now" (well before both far-future dates) — must be
  // inactivated once both dates are FINAL_RESULTS.
  const label = randomUUID().slice(0, 8).toUpperCase();
  const unengaged = await api.post<{ data: { id: string; status: string } }>(
    "/athletes",
    {
      firstName: "Unengaged",
      firstSurname: label,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `AI${label}`,
      currentClubId: fx1.club1Id,
      status: "PENDING_APPROVAL",
    },
    adminToken
  );
  expect(unengaged.data.status).toBe("PENDING_APPROVAL");

  // The "an athlete WITH participation stays untouched" case is already
  // covered deterministically by the backend integration suite (full
  // control over exactly which 2 dates exist) — not repeated here.

  await finalizeDate(adminToken, fx1);
  await finalizeDate(adminToken, fx2);

  const after = await api.get<{ data: { id: string; status: string } }>(
    `/athletes/${unengaged.data.id}`,
    adminToken
  );
  expect(after.data.status).toBe("INACTIVE");
});
