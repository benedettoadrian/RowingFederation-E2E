import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Manual "pasar a eliminatorias" — river/track conditions sometimes force a
 * prueba into heats even when it would fit in a single final (see
 * [[fur-final-to-heats-conversion-plan]]). No drag simulation needed here —
 * convert/undo are plain button clicks, unlike the drag-and-drop features
 * elsewhere in this suite.
 */

async function loginApi(email: string, password: string): Promise<string> {
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
      documentNumber: `F2H${label}`,
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

test("converts a direct final to heats (2 series by default), confirms, and persists real A/B series instead of Final @tier0", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  // 3 boats, pista maxLanes=6 -> fits in a single direct final normally.
  await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);
  const extraId = await extraAthlete(adminToken, fx.club1Id);
  await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, extraId, club1Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorte/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  // Starts as a direct final — the convert button is there, no eliminatoria yet.
  await expect(page.getByRole("button", { name: "Pasar a eliminatorias" })).toBeVisible();
  await page.getByRole("button", { name: "Pasar a eliminatorias" }).click();

  // Now shows as an eliminatoria: 2 series (A/B), split 2/1 (Serie A larger).
  await expect(page.getByText("SERIE A")).toBeVisible();
  await expect(page.getByText("SERIE B")).toBeVisible();
  await expect(page.getByText(/·\s*2\s*botes/)).toBeVisible();
  await expect(page.getByText(/·\s*1\s*bote(?!s)/)).toBeVisible();
  // "+ Agregar serie" now works on this prueba too, same as any real heats event.
  await expect(page.getByRole("button", { name: "Agregar serie" })).toBeVisible();

  await page.getByRole("button", { name: "Confirmar prueba" }).first().click();
  await expect(page.getByText("Prueba confirmada")).toBeVisible();

  const entries = await api.get<{
    data: { eventId: string; series: string | null; lane: number | null }[];
  }>(
    `/competitions/crew-entries/by-event?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}`,
    regattaToken
  );
  const seriesUsed = new Set(entries.data.map((e) => e.series));
  expect(seriesUsed.has("Final")).toBe(false);
  expect(seriesUsed.has("A")).toBe(true);
  expect(seriesUsed.has("B")).toBe(true);
  expect(entries.data).toHaveLength(3);
});

test("undoing a conversion restores the exact original direct final @tier0", async ({ page }) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  await loginAs(page, "REGATTA_COMMISSION");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorte/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  await page.getByRole("button", { name: "Pasar a eliminatorias" }).click();
  await expect(page.getByText("SERIE A")).toBeVisible();

  await page.getByRole("button", { name: "Deshacer" }).click();

  // Back to a direct final — SERIE A/B are gone, the convert button is back.
  await expect(page.getByText("SERIE A")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Pasar a eliminatorias" })).toBeVisible();

  await page.getByRole("button", { name: "Confirmar prueba" }).first().click();
  await expect(page.getByText("Prueba confirmada")).toBeVisible();

  const entries = await api.get<{
    data: { eventId: string; series: string | null }[];
  }>(
    `/competitions/crew-entries/by-event?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}`,
    regattaToken
  );
  expect(entries.data.every((e) => e.series === "Final")).toBe(true);
  expect(entries.data).toHaveLength(2);
});

test("program recalculation after close works for a prueba manually converted to heats, even though Event.hasHeats stays false @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // 4 boats manually confirmed as heat series A/B directly via the API —
  // simulates what the "pasar a eliminatorias" conversion produces, without
  // needing the UI for this specific regression check. fx.eventId's
  // Event.hasHeats stays false in the database the whole time.
  const athleteIds = [
    fx.club1.athleteId,
    ...(await Promise.all(
      Array.from({ length: 3 }, () => extraAthlete(adminToken, fx.club1Id))
    )),
  ];
  const entryIds: string[] = [];
  for (const athleteId of athleteIds) {
    const created = await inscribe(
      fx.competitionDateId,
      fx.eventId,
      fx.club1Id,
      athleteId,
      club1Token
    );
    entryIds.push(created.data.id);
  }

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: entryIds[0]!, series: "A", lane: 1 },
        { entryId: entryIds[1]!, series: "A", lane: 2 },
        { entryId: entryIds[2]!, series: "B", lane: 1 },
        { entryId: entryIds[3]!, series: "B", lane: 2 },
      ],
    },
    regattaToken
  );

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  // One boat withdraws — 3 remain, comfortably fitting in a single final
  // (pista maxLanes=6). Withdrawing during CLOSED requires an elevated
  // role (canOverrideCrewEntry) — a plain club delegate can't, only
  // INSCRIPTION_OPEN/IN_REVIEW.
  await api.delete(`/competitions/crew-entries/${entryIds[3]}`, regattaToken);

  const preview = await api.post<{
    data: { eventId: string; assignments: { entryId: string; series: string; lane: number }[] };
  }>(
    `/competitions/competition-dates/${fx.competitionDateId}/events/${fx.eventId}/recalculate-program/preview`,
    {},
    regattaToken
  );

  expect(preview.data.assignments).toHaveLength(3);
  expect(preview.data.assignments.every((a) => a.series === "Final")).toBe(true);
});
