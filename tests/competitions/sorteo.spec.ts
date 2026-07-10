import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 5.8 — sorteo (draw) preview/confirm, and "programa oficial visible".
 *
 * Ground truth verified against source, not assumed:
 * - Sorteo preview (POST .../sorteo/preview) and confirm (POST
 *   .../sorteo/confirm) have NO competition-date status check at all —
 *   callable at any status, and confirming does NOT itself transition the
 *   date's status. The task description's "cierre + revisión + sorteo"
 *   implies an ordering that the backend doesn't actually enforce.
 * - There is no "sorteo confirmed" flag on CompetitionDate. The "official
 *   program" (GET crew-entries/public) becomes visible purely based on
 *   status being CLOSED/IN_COMPETITION/FINAL_RESULTS — regardless of
 *   whether sorteo/confirm was ever called.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("sorteo preview returns a proposed heat/lane assignment @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  await api.post(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );

  const preview = await api.post<{ data: { events: unknown[] } }>(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/preview`,
    {},
    regattaToken
  );
  expect(preview.data.events.length).toBeGreaterThan(0);
});

test("sorteo confirm writes series/lane onto crew entries @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

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

  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: entry.data.id, series: "Heat 1", lane: 3 }] },
    regattaToken
  );

  const list = await api.get<{ data: Array<{ id: string; series: string; lane: number }> }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  const updated = list.data.find((e) => e.id === entry.data.id);
  expect(updated?.series).toBe("Heat 1");
  expect(updated?.lane).toBe(3);
});

test("public program is hidden before CLOSED, visible once CLOSED @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  // advanceToClosed: false (default) — date sits at INSCRIPTION_OPEN.
  const fxOpen = await setupInscriptionFixtures(adminToken);

  await expect(
    api.get(`/competitions/crew-entries/public?competitionDateId=${fxOpen.competitionDateId}`)
  ).rejects.toMatchObject({ status: 400 });

  const fxClosed = await setupInscriptionFixtures(adminToken, { advanceToClosed: true });
  const publicView = await api.get<{ data: unknown }>(
    `/competitions/crew-entries/public?competitionDateId=${fxClosed.competitionDateId}`
  );
  expect(publicView.data).toBeDefined();
});
