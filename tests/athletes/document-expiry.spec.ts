import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 8.1 — document expiry, reduced scope. The actual auto-deactivation
 * (athlete-document-expiry.scheduler.ts, cron "0 0 * * *") flips ACTIVE ->
 * INACTIVE when identityDocExpirationDate/athleteCardEndDate has passed —
 * but it's cron-only, not exported as a directly-callable function
 * separate from `.start()`, and has no manual-trigger endpoint. Not
 * testable end-to-end without invoking Node internals the E2E stack has no
 * access to. What IS directly testable: the eligibility gate the cron
 * would eventually flip an athlete into. Fase 5.5 already covers
 * PENDING_APPROVAL (the default at creation); this covers the distinct
 * INACTIVE case (what the cron actually produces) via a direct status
 * update instead of waiting for a real expiry cycle.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("an INACTIVE athlete cannot be inscribed (same gate the expiry cron would eventually trip) @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await api.put(`/athletes/${fx.club1.athleteId}`, { status: "INACTIVE" }, adminToken);

  await expect(
    api.post(
      "/competitions/crew-entries",
      {
        competitionDateId: fx.competitionDateId,
        eventId: fx.eventId,
        clubId: fx.club1Id,
        members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      },
      club1Token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
