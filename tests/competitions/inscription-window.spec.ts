import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 7.6 — inscription window. KNOWN GAP, not a passing "it blocks
 * correctly" test: create-crew-entry.use-case.ts / CrewInscriptionValidationService
 * check ONLY competitionDate.status === INSCRIPTION_OPEN — `inscriptionCloseAt`
 * is never read anywhere in that path (verified via grep, zero hits). The
 * actual status flip INSCRIPTION_OPEN -> IN_REVIEW is done by a cron job
 * (competition-date.scheduler.ts) that polls at most every 30 minutes and
 * only while armed by a once-daily gatekeeper — so a crew entry can be
 * legitimately created up to ~30+ minutes after inscriptionCloseAt has
 * passed, purely because the scheduled transition hasn't run yet.
 *
 * This test proves the gap directly (no cron involved): set
 * inscriptionCloseAt in the past at creation time, leave status
 * INSCRIPTION_OPEN (never touch the scheduler), and confirm crew-entry
 * creation still succeeds. Per the user's 2026-07-10 decision, documented
 * rather than fixed in this pass — do not "fix" this test to expect a
 * rejection without first adding a time check to the validation service
 * (or wiring the scheduler into the test) and getting sign-off.
 */

test("KNOWN GAP: a crew entry can be created after inscriptionCloseAt has passed, as long as status is still INSCRIPTION_OPEN @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, {
    dateOverrides: {
      // Both in the past (open still has to precede close, per the
      // create-competition-date validation) — status stays INSCRIPTION_OPEN
      // because nothing (no cron, no manual transition) has moved it,
      // which is exactly the gap being pinned.
      inscriptionOpenAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      inscriptionCloseAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  });
  const club1Token = await (async () => {
    const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
      email: fx.club1.delegateEmail,
      password: fx.club1.delegatePassword,
    });
    return res.data.accessToken;
  })();

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );

  expect(entry.data.id).toBeTruthy();
});
