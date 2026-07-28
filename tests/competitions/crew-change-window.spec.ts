import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

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
      nationality: "Uruguay",
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

  // Replacement athlete: ACTIVE in event2 of the SAME date/club — eligible
  // per crew-replacement-eligibility.service.ts even though it's a
  // different prueba, as long as it's the same competitionDateId + club.
  const replacementAthlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Replacement",
      firstSurname: "AlreadyInDate",
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "Uruguay",
      documentType: "PASSPORT",
      documentNumber: `RP${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      members: [{ athleteId: replacementAthlete.data.id, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  const updated = await api.put<{ data: { members: { athleteId: string }[] } }>(
    `/competitions/crew-entries/${entry.data.id}`,
    {
      members: [{ athleteId: replacementAthlete.data.id, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );

  expect(updated.data.members.map((m) => m.athleteId)).toEqual([replacementAthlete.data.id]);
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
      nationality: "Uruguay",
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
