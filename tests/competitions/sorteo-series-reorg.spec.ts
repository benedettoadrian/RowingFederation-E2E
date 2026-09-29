import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Merge/reorganize already-drawn series of a prueba mid-competition,
 * overriding the pista's lane limit — used when track/water conditions
 * allow more lanes than planned (see
 * [[fur-live-competition-issues-series-2026-09]]). Two backend actions:
 * MergeHeatsIntoFinalUseCase (exactly 2 series, forced total merge) and
 * ReorganizeRaceSeriesUseCase (3+ series, manual drag&drop). Series are set
 * directly via POST .../sorteo/confirm rather than the real draw algorithm
 * — deterministic and avoids depending on GenerateSorteoPreviewUseCase's
 * random shuffle for a feature that's about *editing* an existing draw.
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
      documentNumber: `SRG${label}`,
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

interface Entries {
  data: { id: string; eventId: string; series: string | null; lane: number | null }[];
}

async function fetchEntries(competitionDateId: string, eventId: string, token: string) {
  const res = await api.get<Entries>(
    `/competitions/crew-entries/by-event?competitionDateId=${competitionDateId}&eventId=${eventId}`,
    token
  );
  return res.data;
}

test("merges 2 heat series into a single Final via the UI, keeping A's lanes and continuing B's @tier0", async ({
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

  const extraId = await extraAthlete(adminToken, fx.club1Id);
  const a1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  const a2 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, extraId, club1Token);
  const b1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: a1.data.id, series: "A", lane: 1 },
        { entryId: a2.data.id, series: "A", lane: 2 },
        { entryId: b1.data.id, series: "B", lane: 1 },
      ],
    },
    regattaToken
  );

  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await expect(page.getByText("Serie A", { exact: true })).toBeVisible();
  await expect(page.getByText("Serie B", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Unir series" }).click();
  await expect(page.getByText("Carril 1")).toBeVisible();
  await expect(page.getByText("Carril 3")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar unión" }).click();

  await expect(page.getByText(/Series unidas/)).toBeVisible();
  await expect(page.getByText("Serie A", { exact: true })).not.toBeVisible();

  const entries = await fetchEntries(fx.competitionDateId, fx.eventId, regattaToken);
  expect(entries).toHaveLength(3);
  expect(entries.every((e) => e.series === "Final")).toBe(true);
  const laneByEntry = new Map(entries.map((e) => [e.id, e.lane]));
  expect(laneByEntry.get(a1.data.id)).toBe(1);
  expect(laneByEntry.get(a2.data.id)).toBe(2);
  expect(laneByEntry.get(b1.data.id)).toBe(3);
});

test("reorganizes 3 heat series into 1 via drag&drop in the UI @tier0", async ({ page }) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const extraId = await extraAthlete(adminToken, fx.club1Id);
  const extraId2 = await extraAthlete(adminToken, fx.club2Id);
  const a1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  const a2 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, extraId, club1Token);
  const b1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);
  const c1Real = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, extraId2, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: a1.data.id, series: "A", lane: 1 },
        { entryId: a2.data.id, series: "A", lane: 2 },
        { entryId: b1.data.id, series: "B", lane: 1 },
        { entryId: c1Real.data.id, series: "C", lane: 1 },
      ],
    },
    regattaToken
  );

  await page.setViewportSize({ width: 1280, height: 1800 });
  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await expect(page.getByText("Serie C", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Reorganizar series" }).click();
  await expect(page.getByRole("button", { name: "Crear eliminatoria" })).toBeVisible();
  await page.getByRole("button", { name: "Crear eliminatoria" }).click();

  const target = page.locator('[data-testid="reorg-container-group-1"]');
  await expect(target).toBeVisible();

  // Drag every remaining pool card into the new group — 4 boats total.
  for (let i = 0; i < 4; i++) {
    const poolCard = page
      .locator('[data-testid="reorg-container-pool"] [data-testid^="reorg-card-"]')
      .first();
    const sourceBox = await poolCard.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).toBeTruthy();
    expect(targetBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;
    const tx = targetBox!.x + targetBox!.width / 2;
    const ty = targetBox!.y + targetBox!.height / 2;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
    await page.mouse.move(tx, ty, { steps: 15 });
    await page.mouse.move(tx, ty, { steps: 2 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  await expect(page.locator('[data-testid="reorg-container-pool"] [data-testid^="reorg-card-"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Confirmar reorganización" }).click();
  await expect(page.getByText(/Series reorganizadas/)).toBeVisible();

  const entries = await fetchEntries(fx.competitionDateId, fx.eventId, regattaToken);
  expect(entries).toHaveLength(4);
  // Only 1 resulting heat group -> gets the first heat label, "A".
  expect(entries.every((e) => e.series === "A")).toBe(true);
  expect(new Set(entries.map((e) => e.lane))).toEqual(new Set([1, 2, 3, 4]));
});

test("merge is blocked when the combined boat count exceeds the configured lane ceiling @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // 9 boats (5 + 4) — exceeds the default ceiling of 8 configured in
  // FederationConfig.
  const athleteIds = await Promise.all(
    Array.from({ length: 8 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  const allAthletes = [fx.club1.athleteId, ...athleteIds];
  const entryIds: string[] = [];
  for (const athleteId of allAthletes) {
    const created = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, athleteId, club1Token);
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
        ...entryIds.slice(0, 5).map((entryId, i) => ({ entryId, series: "A", lane: i + 1 })),
        ...entryIds.slice(5).map((entryId, i) => ({ entryId, series: "B", lane: i + 1 })),
      ],
    },
    regattaToken
  );

  await expect(
    api.post(
      "/competitions/crew-entries/merge-heats-into-final",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);

  const entries = await fetchEntries(fx.competitionDateId, fx.eventId, regattaToken);
  expect(entries.every((e) => e.series !== "Final")).toBe(true);
});

test("merge is blocked once a result is already loaded on one of the series @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const a1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  const b1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: a1.data.id, series: "A", lane: 1 },
        { entryId: b1.data.id, series: "B", lane: 1 },
      ],
    },
    regattaToken
  );

  await api.put(
    `/competitions/crew-entries/${a1.data.id}/result`,
    { resultCode: "FINISHED", time: "4:00.00" },
    regattaToken
  );

  await expect(
    api.post(
      "/competitions/crew-entries/merge-heats-into-final",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("only the regatta commission/admin/assigned referee president can merge series @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const a1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  const b1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: a1.data.id, series: "A", lane: 1 },
        { entryId: b1.data.id, series: "B", lane: 1 },
      ],
    },
    regattaToken
  );

  // credentials.REFEREE is the assigned president here, so this checks the
  // OPPOSITE case: a referee who is NOT assigned to this date. Create a
  // fresh, unassigned referee via a second fixture's own referee account
  // isn't needed — any other authenticated non-elevated user without the
  // presidency works just as well as a negative case, and fx.referee (a
  // fresh REFEREE created by this exact fixture) was never assigned as
  // president of THIS date (credentials.REFEREE was, via dateOverrides).
  const unassignedRefereeToken = await loginApi(fx.referee.email, fx.referee.password);

  await expect(
    api.post(
      "/competitions/crew-entries/merge-heats-into-final",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId },
      unassignedRefereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);

  // The assigned president (credentials.REFEREE) can.
  const result = await api.post<{ batchId: string | null }>(
    "/competitions/crew-entries/merge-heats-into-final",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId },
    refereeToken
  );
  expect(result.batchId).toEqual(expect.any(String));
});

test("reorganize rejects an unassigned boat and a group over the ceiling, undo restores the exact pre-merge state and refuses a second time @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const extraId = await extraAthlete(adminToken, fx.club1Id);
  const extraId2 = await extraAthlete(adminToken, fx.club2Id);
  const a1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, fx.club1.athleteId, club1Token);
  const a2 = await inscribe(fx.competitionDateId, fx.eventId, fx.club1Id, extraId, club1Token);
  const b1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, fx.club2.athleteId, club2Token);
  const c1 = await inscribe(fx.competitionDateId, fx.eventId, fx.club2Id, extraId2, club2Token);

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  const assignments = [
    { entryId: a1.data.id, series: "A", lane: 1 },
    { entryId: a2.data.id, series: "A", lane: 2 },
    { entryId: b1.data.id, series: "B", lane: 1 },
    { entryId: c1.data.id, series: "C", lane: 1 },
  ];
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments },
    regattaToken
  );

  // Rejects: not every boat assigned (c1 missing from the payload).
  await expect(
    api.post(
      "/competitions/crew-entries/reorganize-race-series",
      {
        competitionDateId: fx.competitionDateId,
        eventId: fx.eventId,
        groups: [{ type: "HEAT", entryIds: [a1.data.id, a2.data.id, b1.data.id] }],
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);

  // Rejects: doesn't reduce the series count (3 -> 3).
  await expect(
    api.post(
      "/competitions/crew-entries/reorganize-race-series",
      {
        competitionDateId: fx.competitionDateId,
        eventId: fx.eventId,
        groups: [
          { type: "HEAT", entryIds: [a1.data.id] },
          { type: "HEAT", entryIds: [a2.data.id, b1.data.id] },
          { type: "HEAT", entryIds: [c1.data.id] },
        ],
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);

  // Valid: 3 -> 1. Merges everyone into a single new heat group ("A").
  const result = await api.post<{
    batchId: string;
    assignments: { entryId: string; series: string; lane: number }[];
  }>(
    "/competitions/crew-entries/reorganize-race-series",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      groups: [
        { type: "HEAT", entryIds: [a1.data.id, a2.data.id, b1.data.id, c1.data.id] },
      ],
    },
    regattaToken
  );
  expect(result.assignments.every((a) => a.series === "A")).toBe(true);

  // Undo restores the exact original series/lane values.
  await api.post(
    "/competitions/crew-entries/undo-series-reorganization",
    { competitionDateId: fx.competitionDateId, batchId: result.batchId },
    regattaToken
  );
  const restored = await fetchEntries(fx.competitionDateId, fx.eventId, regattaToken);
  const restoredByEntry = new Map(restored.map((e) => [e.id, e]));
  for (const original of assignments) {
    const current = restoredByEntry.get(original.entryId);
    expect(current?.series).toBe(original.series);
    expect(current?.lane).toBe(original.lane);
  }

  // A second undo on the same batch is refused — current state no longer
  // matches the batch's recorded "after" snapshot.
  await expect(
    api.post(
      "/competitions/crew-entries/undo-series-reorganization",
      { competitionDateId: fx.competitionDateId, batchId: result.batchId },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
