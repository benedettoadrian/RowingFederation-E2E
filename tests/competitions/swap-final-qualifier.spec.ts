import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError, withConflictRetry } from "../../fixtures/lib/api.js";
import { setupCompetitionDateFixtures, competitionDatePayload } from "../../fixtures/lib/competitions.js";

/**
 * SwapFinalQualifierUseCase — lets an ADMIN replace a boat that auto-qualified
 * to a Final (AutoDrawFinalUseCase, purely by heat position, no cross-heat
 * time comparison) with a different boat entered in the same event/date that
 * didn't qualify. New feature (2026-09-26), requested after a real case where
 * the auto-draw's heat-position rule didn't match the intended qualifier.
 *
 * Fixture strategy: auto-draw-final's `maxLanes` is a plain request-body
 * number, independent of the pista's actual maxLanes column (which only
 * constrains sorteo/confirm's own lane assignment) — so passing maxLanes: 2
 * there, with a single heat series holding 3 single-seat boats (lanes 1-3,
 * well within the pista's real maxLanes: 6), yields exactly 1 boat that
 * doesn't qualify (qualifiersPerSeries = floor(2/1) = 2). That's the minimal
 * shape that produces both a Final and a leftover non-qualifying candidate
 * to swap in, without needing a second heat series or more athletes than
 * necessary.
 */

interface CrewEntryRow {
  id: string;
  series: string | null;
  lane: number | null;
  clubId: string;
  outOfProgram: boolean;
  status: string;
  members: { athleteId: string }[];
  result: { confirmedAt: string | null } | null;
}

async function buildHeatWithOneNonQualifier() {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const dateFixtures = await setupCompetitionDateFixtures(regattaToken);

  const boat = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    { code: `1X${suffix}`, name: "Single Scull", type: "SHELL", athleteCount: 1, hasCoxswain: false },
    regattaToken
  );
  const ageCategory = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const event = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `1x Senior Masculino ${suffix}`,
      boatId: boat.data.id,
      ageCategoryId: ageCategory.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: true,
    },
    regattaToken
  );
  await api.put(
    `/competitions/programs/${dateFixtures.programId}/events`,
    { eventIds: [event.data.id] },
    regattaToken
  );

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
  const crewChangeWindowOpensAt = new Date();
  crewChangeWindowOpensAt.setUTCDate(crewChangeWindowOpensAt.getUTCDate() - 1);
  const crewChangeWindowClosesAt = new Date();
  crewChangeWindowClosesAt.setUTCDate(crewChangeWindowClosesAt.getUTCDate() + 1);
  const datePayload = competitionDatePayload(dateFixtures, 30 + Math.floor(Math.random() * 500_000), {
    refereePresidentId: referee.data.id,
    crewChangeWindowOpensAt: crewChangeWindowOpensAt.toISOString(),
    crewChangeWindowClosesAt: crewChangeWindowClosesAt.toISOString(),
  });
  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    datePayload,
    regattaToken
  );
  const competitionDateId = created.data.id;
  await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status: "PUBLISHED" }, regattaToken);
  await api.patch(
    `/competitions/competition-dates/${competitionDateId}/status`,
    { status: "INSCRIPTION_OPEN" },
    regattaToken
  );

  async function newAthlete(label: string) {
    const a = await api.post<{ data: { id: string } }>(
      "/athletes",
      {
        firstName: "Heat",
        firstSurname: label,
        gender: "MALE",
        birthdate: "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `HT${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        currentClubId: dateFixtures.clubId,
        status: "ACTIVE",
      },
      adminToken
    );
    return a.data.id;
  }

  async function newEntry(athleteId: string) {
    const e = await api.post<{ data: { id: string } }>(
      "/competitions/crew-entries",
      {
        competitionDateId,
        eventId: event.data.id,
        clubId: dateFixtures.clubId,
        members: [{ athleteId, role: "ROWER" }],
      },
      adminToken
    );
    return e.data.id;
  }

  // 3 single-seat boats in one heat series — with maxLanes=2 (qualifiersPerSeries=2),
  // positions 1 and 2 qualify, position 3 is left behind as the swap-in candidate.
  const athleteFirst = await newAthlete("First");
  const athleteSecond = await newAthlete("Second");
  const athleteThird = await newAthlete("Third");
  const entryFirst = await newEntry(athleteFirst);
  const entrySecond = await newEntry(athleteSecond);
  const entryThird = await newEntry(athleteThird);

  await api.post(
    `/competitions/competition-dates/${competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: entryFirst, series: "A", lane: 1 },
        { entryId: entrySecond, series: "A", lane: 2 },
        { entryId: entryThird, series: "A", lane: 3 },
      ],
    },
    regattaToken
  );

  await withConflictRetry(() =>
    api.put(`/competitions/crew-entries/${entryFirst}/result`, { resultCode: "FINISHED", position: 1, time: "3:40.00" }, regattaToken)
  );
  await withConflictRetry(() =>
    api.put(`/competitions/crew-entries/${entrySecond}/result`, { resultCode: "FINISHED", position: 2, time: "3:45.00" }, regattaToken)
  );
  await withConflictRetry(() =>
    api.put(`/competitions/crew-entries/${entryThird}/result`, { resultCode: "FINISHED", position: 3, time: "3:50.00" }, regattaToken)
  );

  // CLOSED -> IN_COMPETITION is ADMIN-only and needed before auto-draw-final's
  // qualifier can be swapped (SwapFinalQualifierUseCase requires CLOSED or
  // IN_COMPETITION).
  await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status: "IN_REVIEW" }, regattaToken);
  await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status: "CLOSED" }, regattaToken);

  const autoDraw = await api.post<{ success: boolean; skipped: boolean; assigned?: number }>(
    "/competitions/crew-entries/auto-draw-final",
    { competitionDateId, eventId: event.data.id, maxLanes: 2 },
    regattaToken
  );
  expect(autoDraw.skipped).toBe(false);
  expect(autoDraw.assigned).toBe(2);

  async function listAll(): Promise<CrewEntryRow[]> {
    const res = await api.get<{ data: CrewEntryRow[] }>(
      `/competitions/crew-entries/all?competitionDateId=${competitionDateId}`,
      regattaToken
    );
    return res.data.filter((e) => e.status === "ACTIVE");
  }

  const allEntries = await listAll();
  const finalEntries = allEntries.filter((e) => e.series === "Final");
  expect(finalEntries).toHaveLength(2);

  // The entry that qualified with the WORSE time among the two qualifiers —
  // arbitrarily pick the one whose member is athleteFirst or athleteSecond;
  // either is a valid "outgoing" target for the swap.
  const outgoingFinal = finalEntries.find((e) => e.members[0]?.athleteId === athleteSecond)!;
  expect(outgoingFinal).toBeTruthy();

  return {
    adminToken,
    regattaToken,
    competitionDateId,
    eventId: event.data.id,
    entryThird, // the non-qualifier — valid swap-in candidate
    athleteThird,
    outgoingFinal,
    finalEntries,
    listAll,
  };
}

test("ADMIN swaps a Final qualifier for a boat that didn't auto-qualify @tier0", async () => {
  const ctx = await buildHeatWithOneNonQualifier();

  const swap = await api.post<{ success: boolean; newFinalEntryId: string }>(
    `/competitions/crew-entries/${ctx.outgoingFinal.id}/swap-final-qualifier`,
    { incomingCrewEntryId: ctx.entryThird },
    ctx.adminToken
  );
  expect(swap.success).toBe(true);
  expect(swap.newFinalEntryId).not.toBe(ctx.outgoingFinal.id);

  const afterEntries = await ctx.listAll();

  // Outgoing Final entry is gone.
  expect(afterEntries.find((e) => e.id === ctx.outgoingFinal.id)).toBeUndefined();

  // A new Final entry exists, in the same lane, carrying athleteThird.
  const newFinal = afterEntries.find((e) => e.id === swap.newFinalEntryId);
  expect(newFinal).toBeTruthy();
  expect(newFinal!.series).toBe("Final");
  expect(newFinal!.lane).toBe(ctx.outgoingFinal.lane);
  expect(newFinal!.members.map((m) => m.athleteId)).toEqual([ctx.athleteThird]);

  // The heat entry that got promoted (entryThird) is untouched — still a
  // separate row, still series "A", exactly like AutoDrawFinalUseCase leaves
  // the original heat entries of its own qualifiers untouched.
  const heatThird = afterEntries.find((e) => e.id === ctx.entryThird);
  expect(heatThird?.series).toBe("A");

  // The Final block still has exactly 2 active entries (1 untouched
  // qualifier + the new swapped-in one).
  expect(afterEntries.filter((e) => e.series === "Final")).toHaveLength(2);
});

test("a non-ADMIN (REGATTA_COMMISSION) cannot swap a final qualifier @tier0", async () => {
  const ctx = await buildHeatWithOneNonQualifier();

  await expect(
    api.post(
      `/competitions/crew-entries/${ctx.outgoingFinal.id}/swap-final-qualifier`,
      { incomingCrewEntryId: ctx.entryThird },
      ctx.regattaToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("swap is rejected once the final result is confirmed @tier0", async () => {
  const ctx = await buildHeatWithOneNonQualifier();

  // auto-draw-final only copies the roster into the new Final entries, not a
  // result — confirm-block needs every entry in the block to have one first.
  for (const [i, entry] of ctx.finalEntries.entries()) {
    await withConflictRetry(() =>
      api.put(
        `/competitions/crew-entries/${entry.id}/result`,
        { resultCode: "FINISHED", position: i + 1, time: "3:40.00" },
        ctx.regattaToken
      )
    );
  }

  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: ctx.competitionDateId, eventId: ctx.eventId, series: "Final" },
    ctx.regattaToken
  );

  await expect(
    api.post(
      `/competitions/crew-entries/${ctx.outgoingFinal.id}/swap-final-qualifier`,
      { incomingCrewEntryId: ctx.entryThird },
      ctx.adminToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("swap is rejected when the incoming entry already qualified for the Final @tier0", async () => {
  const ctx = await buildHeatWithOneNonQualifier();
  const otherFinalEntry = ctx.finalEntries.find((e) => e.id !== ctx.outgoingFinal.id)!;

  await expect(
    api.post(
      `/competitions/crew-entries/${ctx.outgoingFinal.id}/swap-final-qualifier`,
      { incomingCrewEntryId: otherFinalEntry.id },
      ctx.adminToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
