import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * GET /:id/inscription-summary — real prod bug fix follow-up (see
 * [[fur-three-improvements-2026-09-plan-pointer]]). Feeds the "Resumen"
 * button on the review page. Reuses SorteoService's real heat-count
 * formula (extracted as calculateHeatCount) — this test proves the whole
 * HTTP path end to end, not just the pure calculation (already covered by
 * the backend unit/integration tests).
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
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
      documentNumber: `SUM${label}`,
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

test("inscription summary: per-club totals, heats, single-entry and zero-entry events @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken, { extraEventHasHeats: true });
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginAs(fx.club2.delegateEmail, fx.club2.delegatePassword);

  // eventId (hasHeats: false) gets exactly ONE entry -> eventsWithOneEntry.
  await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);

  // eventId2 (hasHeats: false) gets NOTHING -> eventsWithZeroEntries.

  // eventId3 (hasHeats: true) gets 9 entries across both clubs (pista
  // maxLanes is fixed at 6 by this fixture) -> needs heats. ceil(9/2)=5<=6
  // -> 2 heats, same formula SorteoService.assignHeats uses.
  const club1Extra = await Promise.all(
    Array.from({ length: 4 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  const club2Extra = await Promise.all(
    Array.from({ length: 3 }, () => extraAthlete(adminToken, fx.club2Id))
  );
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, fx.club1.athleteId, club1Token);
  for (const athleteId of club1Extra) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club2Id, fx.club2.athleteId, club2Token);
  for (const athleteId of club2Extra) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club2Id, athleteId, club2Token);
  }

  const summary = await api.get<{
    data: {
      clubs: { clubId: string; clubName: string; athleteCount: number; boatCount: number; eventCount: number }[];
      totalHeats: number;
      eventsWithOneEntry: { eventId: string }[];
      eventsWithZeroEntries: { eventId: string }[];
      heatsDetail: { eventId: string; entryCount: number; heatCount: number }[];
    };
  }>(
    `/competitions/competition-dates/${fx.competitionDateId}/inscription-summary`,
    regattaToken
  );

  const club1Row = summary.data.clubs.find((c) => c.clubId === fx.club1Id);
  const club2Row = summary.data.clubs.find((c) => c.clubId === fx.club2Id);
  expect(club1Row).toMatchObject({ athleteCount: 5, boatCount: 6, eventCount: 2 }); // 1(event)+5(event3)
  expect(club2Row).toMatchObject({ athleteCount: 4, boatCount: 4, eventCount: 1 });

  expect(summary.data.eventsWithOneEntry.map((e) => e.eventId)).toEqual([fx.eventId]);
  expect(summary.data.eventsWithZeroEntries.map((e) => e.eventId)).toEqual([fx.eventId2]);

  expect(summary.data.heatsDetail).toEqual([
    expect.objectContaining({ eventId: fx.eventId3, entryCount: 9, heatCount: 2 }),
  ]);
  expect(summary.data.totalHeats).toBe(2);
});

test("inscription summary rejects a CLUB_DELEGATE (regatta-manager only) @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await expect(
    api.get(
      `/competitions/competition-dates/${fx.competitionDateId}/inscription-summary`,
      club1Token
    )
  ).rejects.toMatchObject({ status: 403 });
});
