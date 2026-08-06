import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import {
  setupInscriptionFixtures,
  setupCompetitionDateFixtures,
  competitionDatePayload,
} from "../../fixtures/lib/competitions.js";

/**
 * Golden path for the athlete competition-history feature — real browser,
 * real backend, real DB. Confirms the button on the athlete profile
 * navigates to the new page, and that a FINISHED result renders with the
 * expected participation status badge.
 */
test("athlete profile links to competition history, which renders a real result", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );
  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "6:15.00" },
    adminToken
  );

  await loginAs(page, "ADMIN");
  await page.goto(`/es/athletes/${fx.club1.athleteId}`);

  await page.getByRole("link", { name: /historial en competencias/i }).click();
  await expect(page).toHaveURL(new RegExp(`/athletes/${fx.club1.athleteId}/historial`));

  const seasonYear = fx.date.slice(0, 4);
  await expect(page.getByText(seasonYear)).toBeVisible(); // season group header

  // fx's competitionDate is a random future year (birthday-paradox-safe
  // fixture), so it's never the current year — only the current season is
  // expanded by default, this one starts collapsed. Expand it.
  await page.getByRole("button", { name: new RegExp(seasonYear) }).click();

  await expect(page.getByText("Completó")).toBeVisible(); // FINISHED participation status
  await expect(page.getByText("Posición 1")).toBeVisible();
});

/**
 * Real user-reported gap (2026-08-06): for team boats, the history page
 * showed the result but never who the athlete actually rowed with.
 * setupInscriptionFixtures' shared boat is a 1x (single-seat) by design, so
 * this needs its own from-scratch 2-seat boat — same minimal pattern as
 * crew-change-window.spec.ts's rejoin test.
 */
test("a team-boat result shows the rest of the crew (crewmates) @tier0", async ({ page }) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const dateFixtures = await setupCompetitionDateFixtures(regattaToken);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const boat2x = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    { code: `2X${suffix}`, name: "Double Scull", type: "SHELL", athleteCount: 2, hasCoxswain: false },
    regattaToken
  );
  const ageCategory = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const event2x = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `2x Senior ${suffix}`,
      boatId: boat2x.data.id,
      ageCategoryId: ageCategory.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: false,
    },
    regattaToken
  );
  await api.put(
    `/competitions/programs/${dateFixtures.programId}/events`,
    { eventIds: [event2x.data.id] },
    regattaToken
  );

  // IN_REVIEW -> CLOSED requires refereePresidentId + crew-change window
  // already set (competition-date-status.service.ts).
  const referee = await api.post<{ data: { id: string } }>(
    "/users",
    {
      email: `referee-${suffix}@e2e.test`,
      password: "E2eTest123",
      firstName: "Referee",
      lastName: suffix,
      birthDate: "1980-01-01",
      gender: "MALE",
      role: "REFEREE",
    },
    adminToken
  );
  const opensAt = new Date();
  opensAt.setUTCDate(opensAt.getUTCDate() - 1);
  const closesAt = new Date();
  closesAt.setUTCDate(closesAt.getUTCDate() + 1);

  const daysFromNow = 30 + Math.floor(Math.random() * 500_000);
  const payload = competitionDatePayload(dateFixtures, daysFromNow, {
    refereePresidentId: referee.data.id,
    crewChangeWindowOpensAt: opensAt.toISOString(),
    crewChangeWindowClosesAt: closesAt.toISOString(),
  });
  const seasonYear = String(payload["date"]).slice(0, 4);

  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    payload,
    regattaToken
  );
  const competitionDateId = created.data.id;
  for (const status of ["PUBLISHED", "INSCRIPTION_OPEN", "IN_REVIEW", "CLOSED"]) {
    await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status }, regattaToken);
  }

  async function newAthlete(label: string) {
    const a = await api.post<{ data: { id: string } }>(
      "/athletes",
      {
        firstName: "Crewmate",
        firstSurname: label,
        gender: "MALE",
        birthdate: "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `CM${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        currentClubId: dateFixtures.clubId,
        status: "ACTIVE",
      },
      adminToken
    );
    return a.data.id;
  }
  const rower1 = await newAthlete("Uno");
  const rower2 = await newAthlete("Dos");

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event2x.data.id,
      clubId: dateFixtures.clubId,
      members: [
        { athleteId: rower1, role: "ROWER" },
        { athleteId: rower2, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );
  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "6:15.00" },
    adminToken
  );

  // API-level: both directions of the pairing see each other, never themselves.
  const history1 = await api.get<{ data: { crewmates: { athleteId: string }[] }[] }>(
    `/athletes/${rower1}/competition-history`,
    adminToken
  );
  expect(history1.data[0]!.crewmates.map((c) => c.athleteId)).toEqual([rower2]);

  await loginAs(page, "ADMIN");
  await page.goto(`/es/athletes/${rower1}/historial`);
  // Only the current season is expanded by default (see the first test in
  // this file) — this fixture's date is a random future year, so expand it.
  await page.getByRole("button", { name: new RegExp(seasonYear) }).click();

  await expect(page.getByText(/Con: Crewmate Dos/)).toBeVisible();
});
