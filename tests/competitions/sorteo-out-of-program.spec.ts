import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Out-of-program boats — urgent federation directive 2026-09-23 (see
 * [[fur-out-of-program-boats-plan]]). A boat inscribed with outOfProgram:
 * true during IN_REVIEW competes normally (real result, real lane) but is
 * excluded from CircuitPoints scoring, and the sorteo always gives it the
 * last lane of whichever series/final it lands in — spread one per
 * series/final when there's more than one in the same prueba. Only
 * ADMIN/REGATTA_COMMISSION, only at inscription time (reviewMode), never
 * editable afterwards.
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
      documentNumber: `OOP${label}`,
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
  token: string,
  extra: Record<string, unknown> = {}
) {
  return api.post<{ data: { id: string; outOfProgram: boolean } }>(
    "/competitions/crew-entries",
    { competitionDateId, eventId, clubId, members: [{ athleteId, role: "ROWER" }], ...extra },
    token
  );
}

test("rejects outOfProgram without reviewMode @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);

  // ForbiddenError (403), not a plain validation 400 — same status the
  // adjacent "reviewMode is only allowed for elevated roles" check uses.
  await expect(
    inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, regattaToken, {
      outOfProgram: true,
    })
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("rejects outOfProgram from a CLUB_DELEGATE even with reviewMode forged in the body @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await expect(
    inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token, {
      reviewMode: true,
      outOfProgram: true,
    })
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("direct final: the out-of-program boat always gets the last lane, persisted through sorteo confirm @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  // 3 boats in a single final (pista maxLanes=6): 2 normal + 1 flagged.
  const normal1 = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );
  const normal2 = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club2Id,
    fx.club2.athleteId,
    club2Token
  );
  const extraId = await extraAthlete(adminToken, fx.club1Id);
  const flagged = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    extraId,
    regattaToken,
    { reviewMode: true, outOfProgram: true }
  );
  expect(flagged.data.outOfProgram).toBe(true);
  expect(normal1.data.outOfProgram).toBe(false);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  const preview = await api.post<{
    data: { events: { eventId: string; assignments: { entryId: string; series: string; lane: number }[] }[] };
  }>(`/competitions/competition-dates/${fx.competitionDateId}/sorteo/preview`, {}, regattaToken);

  const eventResult = preview.data.events.find((e) => e.eventId === fx.eventId)!;
  const byId = new Map(eventResult.assignments.map((a) => [a.entryId, a]));
  const flaggedAssignment = byId.get(flagged.data.id)!;
  const maxLane = Math.max(...eventResult.assignments.map((a) => a.lane));

  expect(flaggedAssignment.series).toBe("Final");
  expect(flaggedAssignment.lane).toBe(maxLane);
  expect(byId.get(normal1.data.id)!.lane).not.toBe(maxLane);
  expect(byId.get(normal2.data.id)!.lane).not.toBe(maxLane);

  // Confirm the sorteo as previewed, then verify it persisted exactly that way.
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: eventResult.assignments },
    regattaToken
  );

  const persisted = await api.get<{
    data: { id: string; series: string | null; lane: number | null; outOfProgram: boolean }[];
  }>(
    `/competitions/crew-entries/by-event?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}`,
    regattaToken
  );
  const persistedFlagged = persisted.data.find((e) => e.id === flagged.data.id)!;
  expect(persistedFlagged.outOfProgram).toBe(true);
  expect(persistedFlagged.lane).toBe(maxLane);
});

test("heats: spreads out-of-program boats one per heat, each in the last lane of its heat @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { extraEventHasHeats: true });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // 9 entries, pista maxLanes=6 -> ceil(9/2)=5<=6 -> 2 heats. 2 of the 9 are
  // out-of-program -> one per heat, each in the last lane of its heat.
  const normalAthletes = await Promise.all(
    Array.from({ length: 7 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  for (const athleteId of normalAthletes) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }
  const flaggedAthleteIds = await Promise.all([
    extraAthlete(adminToken, fx.club1Id),
    extraAthlete(adminToken, fx.club2Id),
  ]);
  const flaggedEntryIds: string[] = [];
  for (const athleteId of flaggedAthleteIds) {
    const created = await inscribe(
      fx.competitionDateId,
      fx.eventId3!,
      athleteId === flaggedAthleteIds[0] ? fx.club1Id : fx.club2Id,
      athleteId,
      regattaToken,
      { reviewMode: true, outOfProgram: true }
    );
    flaggedEntryIds.push(created.data.id);
  }

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  const preview = await api.post<{
    data: { events: { eventId: string; assignments: { entryId: string; series: string; lane: number }[] }[] };
  }>(`/competitions/competition-dates/${fx.competitionDateId}/sorteo/preview`, {}, regattaToken);

  const eventResult = preview.data.events.find((e) => e.eventId === fx.eventId3)!;
  const byId = new Map(eventResult.assignments.map((a) => [a.entryId, a]));
  const flaggedAssignments = flaggedEntryIds.map((id) => byId.get(id)!);

  // Never doubled up in the same heat.
  const heatsUsed = new Set(flaggedAssignments.map((a) => a.series));
  expect(heatsUsed.size).toBe(2);

  // Each is the last lane of its own heat.
  const lanesBySeries = new Map<string, number[]>();
  for (const a of eventResult.assignments) {
    lanesBySeries.set(a.series, [...(lanesBySeries.get(a.series) ?? []), a.lane]);
  }
  for (const a of flaggedAssignments) {
    expect(a.lane).toBe(Math.max(...lanesBySeries.get(a.series)!));
  }
});

test("circuit points: an out-of-program boat that finishes 1st never scores, and 2nd place is re-ranked to 1st's points @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { scoresInCircuit: true });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const championship = await api.post<{ data: { id: string } }>(
    "/competitions/championships",
    {
      name: `Circuito Fuera de Programa ${randomUUID().slice(0, 8)}`,
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

  // Flagged boat inscribed first (via reviewMode, elevated role) — will
  // finish 1st but must never score.
  const extraId = await extraAthlete(adminToken, fx.club1Id);
  const flagged = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    extraId,
    regattaToken,
    { reviewMode: true, outOfProgram: true }
  );
  const scoring = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club2Id,
    fx.club2.athleteId,
    club2Token
  );
  // A third, unrelated normal entry from club1 keeps club1 in the standings
  // query even though its out-of-program boat never scores.
  await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
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

  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: flagged.data.id, series: "Final", lane: 1 },
        { entryId: scoring.data.id, series: "Final", lane: 2 },
      ],
    },
    regattaToken
  );

  await api.put(
    `/competitions/crew-entries/${flagged.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "3:30.00" },
    regattaToken
  );
  await api.put(
    `/competitions/crew-entries/${scoring.data.id}/result`,
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

  // club2 (the real scoring 1st-place finisher once the out-of-program
  // boat is excluded from ranking) must outscore club1 (whose only entry
  // in this event was out-of-program and never scores).
  expect(club2Standing?.total).toBeGreaterThan(0);
  expect(club2Standing?.total).toBeGreaterThan(club1Standing?.total ?? 0);
});

test("review-mode inscription form: checking 'Fuera de programa' persists the flag @tier0", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  const club1 = await api.get<{ data: { name: string } }>(`/clubs/${fx.club1Id}`, regattaToken);

  await loginAs(page, "ADMIN");
  await page.goto(
    `/es/competitions/dates/${fx.competitionDateId}/review/inscriptions/new?eventId=${fx.eventId}`
  );

  const clubOption = page.getByRole("option", { name: club1.data.name });
  // Exact match — the unanchored /Club/i regex also matches every open
  // dropdown option whose club name contains "Club" (e.g. "Club Audit
  // f647ba6f"), which causes a strict-mode violation once enough clubs
  // accumulate in a full-suite run.
  const clubTrigger = page.getByLabel("Club", { exact: true });
  // Under full-suite concurrent load, Next.js hydration can lag behind the
  // SSR'd markup — a click that lands before the Select trigger is actually
  // interactive opens nothing, so retry the click until the option shows up
  // instead of trusting a single click to have worked.
  await expect(async () => {
    await clubTrigger.click();
    await expect(clubOption).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30000 });
  await clubOption.click();

  await expect(page.getByText("Fuera de programa")).toBeVisible();
  // The out-of-program checkbox is the only one on this form's top card —
  // scope by its label text to avoid ambiguity with any other checkbox.
  const checkbox = page
    .locator("div")
    .filter({ hasText: "Fuera de programa" })
    .getByRole("checkbox");
  await checkbox.click();
  await expect(checkbox).toBeChecked();

  // Add one rower so the crew composition is valid, then save.
  await page.getByRole("button", { name: /Remero|Rower/i }).first().click();
  await page.getByRole("button", { name: /Guardar inscripción|Save inscription/i }).click();

  await expect(page).toHaveURL(new RegExp(`/competitions/dates/${fx.competitionDateId}/review$`));

  const entries = await api.get<{
    data: { eventId: string; clubId: string; outOfProgram: boolean }[];
  }>(
    `/competitions/crew-entries/by-event?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}`,
    regattaToken
  );
  const created = entries.data.find((e) => e.clubId === fx.club1Id);
  expect(created?.outOfProgram).toBe(true);
});
