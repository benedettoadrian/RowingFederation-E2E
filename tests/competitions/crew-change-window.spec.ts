import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import {
  setupInscriptionFixtures,
  setupCompetitionDateFixtures,
  competitionDatePayload,
} from "../../fixtures/lib/competitions.js";

/**
 * Fase A (crew-change window) — roster swaps, withdrawals with
 * justification, and the eligible-replacements lookup, all gated to
 * CLOSED/IN_COMPETITION dates that (a) have adminOverride authorization and
 * (b) fall within CompetitionDate.crewChangeWindowOpensAt/ClosesAt.
 *
 * `setupInscriptionFixtures(..., { advanceToClosed: true })` sets a valid
 * crew-change window automatically (see fixtures/lib/competitions.ts) —
 * IN_REVIEW -> CLOSED itself 400s without one, same gate as
 * refereePresidentId (competition-date-status.service.ts).
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("adminOverride swap rejects a replacement not inscribed anywhere in this date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true, // date is already CLOSED — create requires it too
    },
    adminToken
  );

  const strangerAthlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Stranger",
      firstSurname: "NeverInscribed",
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `ST${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      currentClubId: fx.club1Id,
      status: "ACTIVE",
    },
    adminToken
  );

  await expect(
    api.put(
      `/competitions/crew-entries/${entry.data.id}`,
      {
        members: [{ athleteId: strangerAthlete.data.id, role: "ROWER" }],
        adminOverride: true,
      },
      adminToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("adminOverride swap succeeds when the replacement is already ACTIVE in a different event of this date @tier0", async () => {
  // Built from scratch (not setupInscriptionFixtures, which is a 1-seat
  // boat) — a single-seat boat's only member can never be swapped
  // (update-crew-entry.use-case: replacedCount > floor(baselineIds.length/2)
  // is always true when baselineIds.length is 1 — "withdraw the entry
  // instead"). This test is about cross-event swap eligibility, not the
  // single-seat restriction, so it needs a 2-seat boat where swapping one
  // of two members stays within the 50% cap.
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const dateFixtures = await setupCompetitionDateFixtures(regattaToken);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const club1Id = dateFixtures.clubId;

  const boat2x = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    { code: `2X${suffix}`, name: "Double Scull", type: "SHELL", athleteCount: 2, hasCoxswain: false },
    regattaToken
  );
  const ageCategoryA = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-A-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const ageCategoryB = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-B-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const event = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    { name: `2x Senior A ${suffix}`, boatId: boat2x.data.id, ageCategoryId: ageCategoryA.data.id, gender: "MALE", distance: 1000, hasHeats: false },
    regattaToken
  );
  const event2 = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    { name: `2x Senior B ${suffix}`, boatId: boat2x.data.id, ageCategoryId: ageCategoryB.data.id, gender: "MALE", distance: 1000, hasHeats: false },
    regattaToken
  );
  // Program has zero competition dates at this point — modification allowed.
  await api.put(
    `/competitions/programs/${dateFixtures.programId}/events`,
    { eventIds: [event.data.id, event2.data.id] },
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
  for (const status of ["PUBLISHED", "INSCRIPTION_OPEN", "IN_REVIEW", "CLOSED"]) {
    await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status }, regattaToken);
  }

  async function newAthlete(label: string) {
    const a = await api.post<{ data: { id: string } }>(
      "/athletes",
      {
        firstName: "Swap",
        firstSurname: label,
        gender: "MALE",
        birthdate: "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `SW${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        currentClubId: club1Id,
        status: "ACTIVE",
      },
      adminToken
    );
    return a.data.id;
  }
  const original = await newAthlete("Original");
  const partner = await newAthlete("Partner"); // never swapped, stays the whole test
  const replacementAthlete = await newAthlete("Replacement");
  const replacementCrewmate = await newAthlete("ReplacementCrewmate"); // fills the 2nd seat in event2's entry

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event.data.id,
      clubId: club1Id,
      members: [
        { athleteId: original, role: "ROWER" },
        { athleteId: partner, role: "ROWER" },
      ],
      adminOverride: true, // date is already CLOSED — create requires it too
    },
    adminToken
  );

  // Replacement athlete: ACTIVE in event2 of the SAME date/club — eligible
  // per crew-replacement-eligibility.service.ts even though it's a
  // different prueba, as long as it's the same competitionDateId + club.
  await api.post(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event2.data.id,
      clubId: club1Id,
      members: [
        { athleteId: replacementAthlete, role: "ROWER" },
        { athleteId: replacementCrewmate, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );

  const updated = await api.put<{ data: { members: { athleteId: string }[] } }>(
    `/competitions/crew-entries/${entry.data.id}`,
    {
      members: [
        { athleteId: partner, role: "ROWER" },
        { athleteId: replacementAthlete, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );

  expect(updated.data.members.map((m) => m.athleteId).sort()).toEqual(
    [partner, replacementAthlete].sort()
  );
});

test("an athlete can re-join the same boat after being swapped out (soft-delete partial unique index) @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  // Built from scratch (not setupInscriptionFixtures) — needs a 2-seat boat
  // event attached to the program BEFORE any competition date exists
  // ("Program cannot be modified while it has active competition dates"
  // rejects it even at INSCRIPTION_OPEN, not just CLOSED+). A 2-seat boat
  // is required because a single-seat boat's only member can't be swapped
  // at all (update-crew-entry.use-case: "withdraw the entry instead").
  const dateFixtures = await setupCompetitionDateFixtures(regattaToken);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const club1Id = dateFixtures.clubId;

  const boat1x = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    { code: `1X${suffix}`, name: "Single Scull", type: "SHELL", athleteCount: 1, hasCoxswain: false },
    regattaToken
  );
  const boat2x = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    { code: `2X${suffix}`, name: "Double Scull", type: "SHELL", athleteCount: 2, hasCoxswain: false },
    regattaToken
  );
  const ageCategoryA = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-A-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const ageCategoryB = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    { name: `SENIOR-B-${suffix}`, minAge: 19, maxAge: null },
    regattaToken
  );
  const event1x = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `1x Senior ${suffix}`,
      boatId: boat1x.data.id,
      ageCategoryId: ageCategoryA.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: false,
    },
    regattaToken
  );
  const event1xB = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `1x Senior B ${suffix}`,
      boatId: boat1x.data.id,
      ageCategoryId: ageCategoryB.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: false,
    },
    regattaToken
  );
  const event2x = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `2x Senior ${suffix}`,
      boatId: boat2x.data.id,
      ageCategoryId: ageCategoryA.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: false,
    },
    regattaToken
  );
  // Program has zero competition dates at this point — modification allowed.
  await api.put(
    `/competitions/programs/${dateFixtures.programId}/events`,
    { eventIds: [event1x.data.id, event1xB.data.id, event2x.data.id] },
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
  for (const status of ["PUBLISHED", "INSCRIPTION_OPEN", "IN_REVIEW", "CLOSED"]) {
    await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status }, regattaToken);
  }

  async function newAthlete(label: string) {
    const a = await api.post<{ data: { id: string } }>(
      "/athletes",
      {
        firstName: "Rejoin",
        firstSurname: label,
        gender: "MALE",
        birthdate: "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `RJ${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        currentClubId: club1Id,
        status: "ACTIVE",
      },
      adminToken
    );
    return a.data.id;
  }
  const original = await newAthlete("Original");
  const partner = await newAthlete("Partner"); // never swapped, stays the whole test
  const replacement = await newAthlete("Replacement");

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event2x.data.id,
      clubId: club1Id,
      members: [
        { athleteId: original, role: "ROWER" },
        { athleteId: partner, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );

  // Keeps `replacement` eligible (ROWER, active in a different boat than
  // `entry`) per crew-replacement-eligibility.service.ts.
  await api.post(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event1x.data.id,
      clubId: club1Id,
      members: [{ athleteId: replacement, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  // Swap original OUT for replacement — original's CrewMember row in `entry`
  // gets soft-removed (removedAt set, replacedByAthleteId=replacement), not
  // deleted. `partner` stays untouched.
  const swappedOut = await api.put<{ data: { members: { athleteId: string }[] } }>(
    `/competitions/crew-entries/${entry.data.id}`,
    {
      members: [
        { athleteId: partner, role: "ROWER" },
        { athleteId: replacement, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );
  expect(swappedOut.data.members.map((m) => m.athleteId).sort()).toEqual(
    [partner, replacement].sort()
  );

  // Keeps `original` eligible again for the swap back — ACTIVE as ROWER in a
  // different, standalone entry (a fresh single-seat boat elsewhere in the
  // same date/club).
  await api.post(
    "/competitions/crew-entries",
    {
      competitionDateId,
      eventId: event1xB.data.id,
      clubId: club1Id,
      members: [{ athleteId: original, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  // Swap replacement back OUT for original — re-inserts a CrewMember row for
  // (entry, original), the exact (crewEntryId, athleteId) pair that already
  // has a soft-removed row from the first swap. Must succeed: the partial
  // unique index only applies to removedAt IS NULL rows.
  const rejoined = await api.put<{ data: { members: { athleteId: string }[] } }>(
    `/competitions/crew-entries/${entry.data.id}`,
    {
      members: [
        { athleteId: partner, role: "ROWER" },
        { athleteId: original, role: "ROWER" },
      ],
      adminOverride: true,
    },
    adminToken
  );
  expect(rejoined.data.members.map((m) => m.athleteId).sort()).toEqual([original, partner].sort());
});

test("GET eligible-replacements lists an athlete ACTIVE in a different event of the same date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true, // date is already CLOSED — create requires it too
    },
    adminToken
  );

  const candidateAthlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Candidate",
      firstSurname: "FromEvent2",
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `CN${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      currentClubId: fx.club1Id,
      status: "ACTIVE",
    },
    adminToken
  );
  await api.post(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId2,
      clubId: fx.club1Id,
      members: [{ athleteId: candidateAthlete.data.id, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  const candidates = await api.get<{
    data: { athleteId: string; sourceEventId: string }[];
  }>(`/competitions/crew-entries/${entry.data.id}/eligible-replacements`, adminToken);

  expect(candidates.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ athleteId: candidateAthlete.data.id, sourceEventId: fx.eventId2 }),
    ])
  );
  // The entry's own current athlete must not be offered as its own replacement.
  expect(candidates.data.map((c) => c.athleteId)).not.toContain(fx.club1.athleteId);
});

test("withdraw with a justification note persists it on the crew entry @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club2Id,
      members: [{ athleteId: fx.club2.athleteId, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  await api.delete(`/competitions/crew-entries/${entry.data.id}`, adminToken, {
    notes: "Certificado médico adjunto — atleta enfermo",
  });

  const inscriptions = await api.get<{
    data: { id: string; status: string; notes: string | null }[];
  }>(
    `/competitions/crew-entries/by-event?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}`,
    adminToken
  );
  const withdrawn = inscriptions.data.find((e) => e.id === entry.data.id);

  expect(withdrawn?.status).toBe("WITHDRAWN");
  expect(withdrawn?.notes).toBe("Certificado médico adjunto — atleta enfermo");
});

test("adminOverride swap fails once the crew-change window is cleared, even on a CLOSED date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true, // date is already CLOSED — create requires it too
    },
    adminToken
  );

  // crewChangeWindowOpensAt/ClosesAt are "always editable" fields on
  // CompetitionDate — clearing them post-CLOSE is exactly the scenario this
  // gate exists for (a president's window has simply expired).
  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    { crewChangeWindowOpensAt: null, crewChangeWindowClosesAt: null },
    regattaToken
  );

  await expect(
    api.put(
      `/competitions/crew-entries/${entry.data.id}`,
      { members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }], adminOverride: true },
      adminToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("a CLUB_DELEGATE (no adminOverride) still cannot swap once the date is CLOSED @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });
  const delegateToken = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const adminToken = await apiLoginAs("ADMIN");
  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true, // date is already CLOSED — create requires it too
    },
    adminToken
  );

  await expect(
    api.put(
      `/competitions/crew-entries/${entry.data.id}`,
      { members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }] }, // no adminOverride
      delegateToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
