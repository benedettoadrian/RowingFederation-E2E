import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs as loginAsUi, createUserAndResetPassword } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import {
  setupInscriptionFixtures,
  setupCompetitionDateFixtures,
  competitionDatePayload,
} from "../../fixtures/lib/competitions.js";

/**
 * World Rowing (FISA) handicap method for real championships (2026-07-16) —
 * Championship.handicapMethod / CompetitionDate.handicapMethod, the sync
 * rule when linking a date to a championship, the Mixed-crew 50/50 quota
 * (only enforced for Master + World Rowing, never for FUR), and a
 * standalone date (no championship at all) setting its own method.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("golden path: World Rowing method through a real championship, end to end @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  // Same shape as the FUR golden path (master-handicap.spec.ts) — single
  // sculls, two ages 10 years apart — but this date's championship declares
  // World Rowing, so the math (and the result row's handicapMethod) must
  // differ from the FUR test's flat 10s.
  const daysFromNow = 30 + Math.floor(Math.random() * 3000);
  const competitionDate = new Date();
  competitionDate.setUTCDate(competitionDate.getUTCDate() + daysFromNow);
  competitionDate.setUTCHours(0, 0, 0, 0);
  const competitionYear = competitionDate.getUTCFullYear();
  const inscriptionOpenAt = new Date();
  inscriptionOpenAt.setUTCDate(inscriptionOpenAt.getUTCDate() + 1);
  const inscriptionCloseAt = new Date(competitionDate);
  inscriptionCloseAt.setUTCDate(inscriptionCloseAt.getUTCDate() - 1);
  inscriptionCloseAt.setUTCHours(23, 0, 0, 0);

  const fx = await setupInscriptionFixtures(adminToken, {
    isMaster: true,
    dateOverrides: {
      date: competitionDate.toISOString(),
      inscriptionOpenAt: inscriptionOpenAt.toISOString(),
      inscriptionCloseAt: inscriptionCloseAt.toISOString(),
    },
    club1AthleteBirthdate: `${competitionYear - 50}-01-01`,
    club2AthleteBirthdate: `${competitionYear - 60}-01-01`,
  });

  // Championship declares World Rowing, then gets linked to the date —
  // that link stamps the method onto the (method-less) date.
  const championship = await api.post<{ data: { id: string } }>(
    "/competitions/championships",
    {
      name: `Circuito WR ${randomUUID().slice(0, 8)}`,
      type: "CHAMPIONSHIP",
      dateFrom: new Date(competitionYear, 0, 1).toISOString(),
      dateTo: new Date(competitionYear, 11, 31).toISOString(),
      handicapMethod: "WORLD_ROWING",
    },
    regattaToken
  );
  await api.put(
    `/competitions/championships/${championship.data.id}/dates`,
    { competitionDateIds: [fx.competitionDateId] },
    regattaToken
  );

  const dateAfterLink = await api.get<{ data: { handicapMethod: string | null } }>(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    regattaToken
  );
  expect(dateAfterLink.data.handicapMethod).toBe("WORLD_ROWING");

  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginAs(fx.club2.delegateEmail, fx.club2.delegatePassword);

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
    {
      refereePresidentId: fx.referee.userId,
      // IN_REVIEW -> CLOSED also requires both crew-change-window fields
      // set (competition-date-status.service.ts), same gate as referee.
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
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

  await api.put(`/competitions/crew-entries/${entry1.data.id}/result`, { resultCode: "FINISHED", time: "4:00.00" }, regattaToken);
  await api.put(`/competitions/crew-entries/${entry2.data.id}/result`, { resultCode: "FINISHED", time: "4:00.00" }, regattaToken);

  const calc = await api.post<{ success: boolean; updated: number }>(
    "/competitions/crew-entries/calculate-master-handicap",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
  expect(calc.updated).toBe(2);

  // GET /crew-entries/all is the referee/regatta-manager working view —
  // always raw, never confirmedAt-gated. The club-scoped endpoint
  // (GET /crew-entries?clubId=) waits for the president to confirm the
  // block, same as the public feed — a delegate must not see their own
  // boat's result before it's official, confirmed with the business owner.
  const list = await api.get<{
    data: Array<{
      id: string;
      result: {
        handicapMethod: string | null;
        handicapCentiseconds: number | null;
        coefficientVersion: string | null;
        officialTime: string | null;
      } | null;
    }>;
  }>(`/competitions/crew-entries/all?competitionDateId=${fx.competitionDateId}`, regattaToken);
  const result1 = list.data.find((e) => e.id === entry1.data.id)?.result;
  expect(result1).toMatchObject({ handicapMethod: "WORLD_ROWING", coefficientVersion: "WR_2026_03" });

  const result2 = list.data.find((e) => e.id === entry2.data.id)?.result;

  // Federation's own worked example: M 1x, 50 vs 60 years -> 9.167s apart —
  // not FUR's flat 10s for the same 10-year gap.
  const diffCentiseconds = result2!.handicapCentiseconds! - result1!.handicapCentiseconds!;
  expect(Math.abs(diffCentiseconds - 917)).toBeLessThanOrEqual(5);

  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
});

test("rejects linking a date to a championship when their handicap methods conflict @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const cdFixtures = await setupCompetitionDateFixtures(regattaToken);

  const datePayload = competitionDatePayload(cdFixtures, 30 + Math.floor(Math.random() * 500_000), {
    handicapMethod: "FUR",
  });
  const date = await api.post<{ data: { id: string } }>("/competitions/competition-dates", datePayload, regattaToken);

  const championship = await api.post<{ data: { id: string } }>(
    "/competitions/championships",
    {
      name: `Circuito Conflicto ${randomUUID().slice(0, 8)}`,
      type: "CHAMPIONSHIP",
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-12-31T00:00:00.000Z",
      handicapMethod: "WORLD_ROWING",
    },
    regattaToken
  );

  await expect(
    api.put(
      `/competitions/championships/${championship.data.id}/dates`,
      { competitionDateIds: [date.data.id] },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);

  // The date's own method is untouched — proves the rejected link didn't
  // silently overwrite it.
  const unchanged = await api.get<{ data: { handicapMethod: string | null } }>(
    `/competitions/competition-dates/${date.data.id}`,
    regattaToken
  );
  expect(unchanged.data.handicapMethod).toBe("FUR");
});

test("standalone date (no championship) with its own World Rowing method calculates correctly @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  const daysFromNow = 30 + Math.floor(Math.random() * 3000);
  const competitionDate = new Date();
  competitionDate.setUTCDate(competitionDate.getUTCDate() + daysFromNow);
  competitionDate.setUTCHours(0, 0, 0, 0);
  const competitionYear = competitionDate.getUTCFullYear();
  const inscriptionOpenAt = new Date();
  inscriptionOpenAt.setUTCDate(inscriptionOpenAt.getUTCDate() + 1);
  const inscriptionCloseAt = new Date(competitionDate);
  inscriptionCloseAt.setUTCDate(inscriptionCloseAt.getUTCDate() - 1);
  inscriptionCloseAt.setUTCHours(23, 0, 0, 0);

  // Standalone — no championship created or linked at all.
  const fx = await setupInscriptionFixtures(adminToken, {
    isMaster: true,
    dateOverrides: {
      date: competitionDate.toISOString(),
      inscriptionOpenAt: inscriptionOpenAt.toISOString(),
      inscriptionCloseAt: inscriptionCloseAt.toISOString(),
      handicapMethod: "WORLD_ROWING",
    },
    club1AthleteBirthdate: `${competitionYear - 27}-01-01`,
  });

  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
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

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      // IN_REVIEW -> CLOSED also requires both crew-change-window fields
      // set (competition-date-status.service.ts), same gate as referee.
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: entry1.data.id, series: "Final", lane: 1 }] },
    regattaToken
  );
  await api.put(`/competitions/crew-entries/${entry1.data.id}/result`, { resultCode: "FINISHED", time: "4:00.00" }, regattaToken);

  const calc = await api.post<{ success: boolean; updated: number }>(
    "/competitions/crew-entries/calculate-master-handicap",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
  expect(calc.updated).toBe(1);

  const list = await api.get<{
    data: Array<{ id: string; result: { handicapMethod: string | null; handicapCentiseconds: number | null } | null }>;
  }>(`/competitions/crew-entries/all?competitionDateId=${fx.competitionDateId}`, regattaToken);
  const result = list.data.find((e) => e.id === entry1.data.id)?.result;

  // Reference is this date's own gender+class at age 27 (Sistema Agazzi
  // design — see fur-fisa-handicap-full-plan notes), not a fixed cross-class
  // constant. This crew is M 1x at exactly age 27 — its own class's
  // reference age — so its handicap is ~0 by construction, while still
  // confirming World Rowing (not FUR) actually ran via handicapMethod.
  expect(result?.handicapMethod).toBe("WORLD_ROWING");
  expect(Math.abs(result!.handicapCentiseconds!)).toBeLessThanOrEqual(5);
});

test("rejects a Mixed crew that isn't 50/50 for a Master event under the World Rowing method @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const cdFixtures = await setupCompetitionDateFixtures(regattaToken);

  const boat = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    {
      code: `2X${suffix}`,
      name: "Double Scull",
      type: "SHELL",
      style: "SCULL",
      athleteCount: 2,
      hasCoxswain: false,
    },
    regattaToken
  );
  const ageCategory = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `MASTER-MIX-${suffix}`, minAge: 27, maxAge: null, isMaster: true },
    regattaToken
  );
  const event = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `2x Master Mixto ${suffix}`,
      boatId: boat.data.id,
      ageCategoryId: ageCategory.data.id,
      gender: "MIXED",
      distance: 1000,
      hasHeats: false,
    },
    regattaToken
  );
  const program = await api.post<{ data: { id: string } }>(
    "/competitions/programs",
    { name: `Programa Mixto ${suffix}` },
    regattaToken
  );
  await api.put(`/competitions/programs/${program.data.id}/events`, { eventIds: [event.data.id] }, regattaToken);

  const datePayload = competitionDatePayload(
    { ...cdFixtures, programId: program.data.id },
    30 + Math.floor(Math.random() * 500_000),
    { handicapMethod: "WORLD_ROWING" }
  );
  const date = await api.post<{ data: { id: string } }>("/competitions/competition-dates", datePayload, regattaToken);
  await api.patch(`/competitions/competition-dates/${date.data.id}/status`, { status: "PUBLISHED" }, regattaToken);
  await api.patch(`/competitions/competition-dates/${date.data.id}/status`, { status: "INSCRIPTION_OPEN" }, regattaToken);

  const delegateEmail = `delegate-mix-${suffix}@e2e.test`;
  const delegate = await createUserAndResetPassword(
    adminToken,
    {
      email: delegateEmail,
      firstName: "Delegate",
      lastName: suffix,
      birthDate: "1990-01-01",
      gender: "MALE",
      role: "CLUB_DELEGATE",
      clubId: cdFixtures.clubId,
    },
    "E2eTest123"
  );
  const delegateToken = await loginAs(delegateEmail, delegate.password);

  const maleAthlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Male",
      firstSurname: suffix,
      gender: "MALE",
      birthdate: "1990-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `MX1${suffix}`,
      currentClubId: cdFixtures.clubId,
      status: "ACTIVE",
    },
    adminToken
  );
  const maleAthlete2 = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Male2",
      firstSurname: suffix,
      gender: "MALE",
      birthdate: "1990-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `MX2${suffix}`,
      currentClubId: cdFixtures.clubId,
      status: "ACTIVE",
    },
    adminToken
  );

  // Two male rowers in a Mixed event — GenderEligibilityVO alone would
  // accept this (MIXED allows any gender individually); the World Rowing
  // 50/50 quota rule is what must reject it.
  await expect(
    api.post(
      "/competitions/crew-entries",
      {
        competitionDateId: date.data.id,
        eventId: event.data.id,
        clubId: cdFixtures.clubId,
        members: [
          { athleteId: maleAthlete.data.id, role: "ROWER" },
          { athleteId: maleAthlete2.data.id, role: "ROWER" },
        ],
      },
      delegateToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("results sheet shows the didactic World Rowing detail with real numbers @tier1", async ({ page }) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  const daysFromNow = 30 + Math.floor(Math.random() * 3000);
  const competitionDate = new Date();
  competitionDate.setUTCDate(competitionDate.getUTCDate() + daysFromNow);
  competitionDate.setUTCHours(0, 0, 0, 0);
  const competitionYear = competitionDate.getUTCFullYear();
  const inscriptionOpenAt = new Date();
  inscriptionOpenAt.setUTCDate(inscriptionOpenAt.getUTCDate() + 1);
  const inscriptionCloseAt = new Date(competitionDate);
  inscriptionCloseAt.setUTCDate(inscriptionCloseAt.getUTCDate() - 1);
  inscriptionCloseAt.setUTCHours(23, 0, 0, 0);

  const fx = await setupInscriptionFixtures(adminToken, {
    isMaster: true,
    dateOverrides: {
      date: competitionDate.toISOString(),
      inscriptionOpenAt: inscriptionOpenAt.toISOString(),
      inscriptionCloseAt: inscriptionCloseAt.toISOString(),
      handicapMethod: "WORLD_ROWING",
    },
    club1AthleteBirthdate: `${competitionYear - 50}-01-01`,
  });

  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
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

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      // IN_REVIEW -> CLOSED also requires both crew-change-window fields
      // set (competition-date-status.service.ts), same gate as referee.
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: entry1.data.id, series: "Final", lane: 1 }] },
    regattaToken
  );
  await api.put(`/competitions/crew-entries/${entry1.data.id}/result`, { resultCode: "FINISHED", time: "4:00.00" }, regattaToken);
  await api.post(
    "/competitions/crew-entries/calculate-master-handicap",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );

  // The results page only renders for IN_COMPETITION/FINAL_RESULTS dates.
  await api.patch(`/competitions/competition-dates/${fx.competitionDateId}/status`, { status: "IN_REVIEW" }, regattaToken);
  await api.patch(`/competitions/competition-dates/${fx.competitionDateId}/status`, { status: "CLOSED" }, regattaToken);
  // Manually forcing CLOSED -> IN_COMPETITION is ADMIN-only (competition-date.controller.ts:217).
  await api.patch(`/competitions/competition-dates/${fx.competitionDateId}/status`, { status: "IN_COMPETITION" }, adminToken);

  await loginAsUi(page, "REGATTA_COMMISSION");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/results`);

  await page.getByRole("button", { name: "Cargar resultados" }).first().click();

  // The always-visible config bar above the table, inside the sheet.
  await expect(page.getByText("Sistema: World Rowing (FISA)")).toBeVisible();
  await expect(page.getByText(/Clase de bote: Masculino 1x/)).toBeVisible();

  await page.getByRole("button", { name: "Ver detalle del cálculo" }).click();

  // Real numbers, not just section headings — proves the didactic panel is
  // actually wired to this crew's own computed result, not placeholder text.
  await expect(page.getByText("Modelo World Rowing utilizado")).toBeVisible();
  await expect(page.getByText("Masculino 1x").first()).toBeVisible();
  await expect(page.getByText(/3:46\.08 \(tiempo de referencia\)/)).toBeVisible();

  await page.getByRole("button", { name: "Ver coeficientes del modelo" }).first().click();
  await expect(page.getByText(/a=541\.875264, b=0\.060336, c=223315\.25/)).toBeVisible();
  await expect(page.getByText("Versión: WR_2026_03")).toBeVisible();
});
