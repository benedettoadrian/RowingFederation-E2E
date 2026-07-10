import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 5.10 — circuit standings. Real backend calculation (not
 * frontend-only), triggered inside POST crew-entries/confirm-block, gated
 * on event.scoresInCircuit === true AND the competition date belonging to
 * a CIRCUIT-type championship. Points come from FederationConfig defaults
 * (1st=5, 2nd=3, 3rd=2, 4th=1). This is the heaviest fixture chain in the
 * suite: entries -> referee assigned -> IN_REVIEW -> CLOSED -> sorteo
 * confirm (series must be exactly "Final" — confirm-block's circuit-points
 * logic only re-ranks "Final" blocks) -> results -> confirm-block.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("confirming a Final block computes and exposes circuit standings @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken, { scoresInCircuit: true });
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginAs(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const championship = await api.post<{ data: { id: string } }>(
    "/competitions/championships",
    {
      name: `Circuito Standings ${randomUUID().slice(0, 8)}`,
      type: "CIRCUIT",
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-12-31T00:00:00.000Z",
    },
    adminToken
  );
  await api.put(
    `/competitions/championships/${championship.data.id}/dates`,
    { competitionDateIds: [fx.competitionDateId] },
    adminToken
  );

  const entry1 = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );
  const entry2 = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club2Id,
      members: [{ athleteId: fx.club2.athleteId, role: "ROWER" }],
    },
    club2Token
  );

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    { refereePresidentId: fx.referee.userId },
    regattaToken
  );

  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: entry1.data.id, series: "Final", lane: 1 },
        { entryId: entry2.data.id, series: "Final", lane: 2 },
      ],
    },
    regattaToken
  );

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  await api.put(
    `/competitions/crew-entries/${entry1.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "3:40.00" },
    regattaToken
  );
  await api.put(
    `/competitions/crew-entries/${entry2.data.id}/result`,
    { resultCode: "FINISHED", position: 2, time: "3:45.00" },
    regattaToken
  );

  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );

  const byClub = await api.get<{
    data: { ranking: Array<{ clubId: string; total: number }> };
  }>(`/competitions/championships/${championship.data.id}/standings/by-club`);
  const club1Standing = byClub.data.ranking.find((s) => s.clubId === fx.club1Id);
  const club2Standing = byClub.data.ranking.find((s) => s.clubId === fx.club2Id);

  // 1st place (club1) must outscore 2nd place (club2) — exact point values
  // come from FederationConfig defaults (5/3/2/1), not asserted directly
  // here to avoid coupling the test to config that could reasonably change.
  expect(club1Standing?.total).toBeGreaterThan(0);
  expect(club1Standing?.total).toBeGreaterThan(club2Standing?.total ?? 0);
});
