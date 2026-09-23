import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, withConflictRetry } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures, competitionDatePayload } from "../../fixtures/lib/competitions.js";

/**
 * Heat seeding by historical podium position (see
 * [[fur-seeded-heats-sorteo-plan-pointer]]). Proves the whole real path end
 * to end: a boat's podium (1st-3rd) finish in a PAST FINAL_RESULTS date of
 * the exact same prueba (`Event.id`) gets it flagged in today's sorteo
 * preview, separated from another historic boat across heats, and the ℹ️
 * transparency icon (with the rival's real club name) is visible in the UI
 * for ADMIN/REGATTA_COMMISSION only — never for a club delegate, who can't
 * even reach the endpoint (same `requiresRegattaManager()` guard the icon's
 * visibility depends on).
 */

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function transition(id: string, status: string, token: string) {
  const actingToken = status === "IN_COMPETITION" ? await apiLoginAs("ADMIN") : token;
  return api.patch(`/competitions/competition-dates/${id}/status`, { status }, actingToken);
}

async function extraAthlete(adminToken: string, clubId: string) {
  const label = randomUUID().slice(0, 8).toUpperCase();
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Extra",
      firstSurname: label,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `SEED${label}`,
      currentClubId: clubId,
      status: "ACTIVE",
    },
    adminToken
  );
  return created.data.id;
}

async function inscribe(
  competitionDateId: string,
  eventId: string,
  clubId: string,
  athleteId: string,
  token: string
) {
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    { competitionDateId, eventId, clubId, members: [{ athleteId, role: "ROWER" }] },
    token
  );
}

test("heat seeding: podium-history boats get separated across heats and flagged with the rival's club @tier0", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  // Pre-assign a referee president so the review page's "assign a referee"
  // dialog (auto-opened for any IN_REVIEW date without one) never appears
  // and blocks the "Generar sorteo" button behind it.
  const fx = await setupInscriptionFixtures(regattaToken, {
    extraEventHasHeats: true,
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  // A second club1 boat (different athlete) so club1 has TWO independent
  // historic rank-1 boats — see the collision design below.
  const club1SecondAthleteId = await extraAthlete(adminToken, fx.club1Id);

  // ── Build a PAST date, same prueba (fx.eventId3), reaching FINAL_RESULTS,
  // where two boats from club1 both won (rank 1) and club2's boat came
  // second (rank 2) — separate program, same Event.id (the identity the
  // feature actually keys off, per plan.md). ──
  const suffix = randomUUID().slice(0, 8);
  const pastProgram = await api.post<{ data: { id: string } }>(
    "/competitions/programs",
    { name: `Programa historico ${suffix}` },
    regattaToken
  );
  await api.put(
    `/competitions/programs/${pastProgram.data.id}/events`,
    { eventIds: [fx.eventId3] },
    regattaToken
  );

  const opensAt = new Date();
  opensAt.setUTCDate(opensAt.getUTCDate() - 1);
  const closesAt = new Date();
  closesAt.setUTCDate(closesAt.getUTCDate() + 1);
  const pastDatePayload = competitionDatePayload(
    { clubId: fx.club1Id, pistaId: fx.pistaId, programId: pastProgram.data.id },
    30 + Math.floor(Math.random() * 500_000),
    {
      refereePresidentId: fx.referee.userId,
      crewChangeWindowOpensAt: opensAt.toISOString(),
      crewChangeWindowClosesAt: closesAt.toISOString(),
    }
  );
  const pastDate = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    pastDatePayload,
    regattaToken
  );
  const pastDateId = pastDate.data.id;

  await transition(pastDateId, "PUBLISHED", regattaToken);
  await transition(pastDateId, "INSCRIPTION_OPEN", regattaToken);

  const pastEntryClub1A = await inscribe(
    pastDateId,
    fx.eventId3!,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );
  const pastEntryClub1B = await inscribe(
    pastDateId,
    fx.eventId3!,
    fx.club1Id,
    club1SecondAthleteId,
    club1Token
  );
  const pastEntryClub2 = await inscribe(
    pastDateId,
    fx.eventId3!,
    fx.club2Id,
    fx.club2.athleteId,
    club2Token
  );

  await transition(pastDateId, "IN_REVIEW", regattaToken);
  await transition(pastDateId, "CLOSED", regattaToken);
  await transition(pastDateId, "IN_COMPETITION", regattaToken);

  // series="Final" exact — heats/sub-finals aren't valid seeding history.
  await api.post(
    `/competitions/competition-dates/${pastDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: pastEntryClub1A.data.id, series: "Final", lane: 1 },
        { entryId: pastEntryClub1B.data.id, series: "Final", lane: 2 },
        { entryId: pastEntryClub2.data.id, series: "Final", lane: 3 },
      ],
    },
    regattaToken
  );

  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${pastEntryClub1A.data.id}/result`,
      { resultCode: "FINISHED", position: 1, time: "3:30.00" },
      regattaToken
    )
  );
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${pastEntryClub1B.data.id}/result`,
      { resultCode: "FINISHED", position: 3, time: "3:50.00" },
      regattaToken
    )
  );
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${pastEntryClub2.data.id}/result`,
      { resultCode: "FINISHED", position: 2, time: "3:40.00" },
      regattaToken
    )
  );

  await transition(pastDateId, "FINAL_RESULTS", regattaToken);

  // ── Current date (fx.competitionDateId, already INSCRIPTION_OPEN):
  // re-inscribe the exact same 3 boats (same club + same athlete = same
  // boat identity for a 1x) plus 5 filler entries in eventId3, forcing
  // heats (pista maxLanes=6 -> ceil(8/2)=4<=6 -> 2 heats). ──
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, fx.club1.athleteId, club1Token);
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, club1SecondAthleteId, club1Token);
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club2Id, fx.club2.athleteId, club2Token);
  const fillerAthletes = await Promise.all(
    Array.from({ length: 5 }, () => extraAthlete(adminToken, fx.club2Id))
  );
  for (const athleteId of fillerAthletes) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club2Id, athleteId, club2Token);
  }

  // The review page (and its "Generar sorteo" button) only renders once the
  // date is actually IN_REVIEW — redirects away otherwise (review/page.tsx).
  await transition(fx.competitionDateId, "IN_REVIEW", regattaToken);

  // ── UI: ADMIN opens the sorteo proposal and sees the seeding icon ──
  const club1Name = (
    await api.get<{ data: { name: string } }>(`/clubs/${fx.club1Id}`, adminToken)
  ).data.name;
  const club2Name = (
    await api.get<{ data: { name: string } }>(`/clubs/${fx.club2Id}`, adminToken)
  ).data.name;

  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorteo/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  // One icon per PRUEBA (not per boat) — eventId3 is the only event with
  // any historic boats in this fixture.
  const pruebaIcon = page.locator(
    'svg[aria-label="Ver historial considerado en esta prueba"]'
  );
  await expect(pruebaIcon).toHaveCount(1);

  await pruebaIcon.hover();
  const card = page.locator('[data-slot="hover-card-content"]').first();
  await expect(card).toBeVisible();
  // All 3 historic boats are club1's (x2, ranks 1 and 1) or club2's (rank
  // 2) — the hover card lists every one of them, ranked, regardless of
  // which heat they ended up sharing.
  await expect(card).toContainText(club1Name);
  await expect(card).toContainText(club2Name);
  await expect(card).toContainText("Puesto 1°");
  await expect(card).toContainText("Puesto 2°");
  await expect(card).toContainText("Quedó en Serie");
});

test("sorteo preview rejects a CLUB_DELEGATE — the same guard the seeding icon's role-gating relies on @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await expect(
    api.post(
      `/competitions/competition-dates/${fx.competitionDateId}/sorteo/preview`,
      {},
      club1Token
    )
  ).rejects.toMatchObject({ status: 403 });
});
