import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Real bloqueo de inscripción para la categoría Novicio — see
 * [[fur-novice-category-eligibility-plan]]. `fx.eventId` is the Novicio
 * event (isNovice: true on its age category); `fx.eventId2` is always a
 * plain Senior event on the SAME competition date — used here to build
 * "recent non-Novicio history" for an athlete before attempting to inscribe
 * them into the Novicio event.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function createEntry(
  fx: Awaited<ReturnType<typeof setupInscriptionFixtures>>,
  eventId: string,
  token: string,
  overrides: Record<string, unknown> = {}
) {
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      ...overrides,
    },
    token
  );
}

test("golden path: a fresh athlete with no history can be inscribed in Novicio @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const created = await createEntry(fx, fx.eventId, token);
  expect(created.data.id).toBeTruthy();
});

test("rejects inscribing an athlete into Novicio who has recent non-Novicio history @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // Build history: inscribe the athlete in the plain Senior event first.
  await createEntry(fx, fx.eventId2, token);

  await expect(createEntry(fx, fx.eventId, token)).rejects.toMatchObject({
    status: 400,
  } satisfies Partial<ApiError>);
});

test("rejects overrideNoviceEligibility from a CLUB_DELEGATE @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, fx.eventId2, token);

  const rejection = await createEntry(fx, fx.eventId, token, {
    overrideNoviceEligibility: true,
  }).catch((e) => e);

  expect(rejection).toBeInstanceOf(ApiError);
  expect((rejection as ApiError).status).toBe(400);
  expect((rejection as ApiError).message).toContain("overrideNoviceEligibility");
});

test("allows overrideNoviceEligibility from ADMIN to bypass an ineligible Novicio result @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, fx.eventId2, token);

  const created = await createEntry(fx, fx.eventId, adminToken, {
    overrideNoviceEligibility: true,
  });
  expect(created.data.id).toBeTruthy();
});

test("GET eligible-athletes previews the Novicio ineligibility reason before submission @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, fx.eventId2, token);

  const preview = await api.get<{
    data: { athleteId: string; ineligibilityReason: string | null }[];
  }>(
    `/competitions/crew-entries/eligible-athletes?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}&clubId=${fx.club1Id}`,
    token
  );

  const row = preview.data.find((r) => r.athleteId === fx.club1.athleteId);
  expect(row?.ineligibilityReason).toContain("Not eligible for Novicio");
});

test("rejects REPLACING a Novicio crew member with an athlete who has recent non-Novicio history @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { isNovice: true });
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // Original entry with an eligible (fresh, no history) athlete.
  const entry = await createEntry(fx, fx.eventId, token);

  // A second athlete who already has non-Novicio history.
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Replacement",
      firstSurname: `Novice${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `NV${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
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
      members: [{ athleteId: created.data.id, role: "ROWER" }],
    },
    token
  );

  await expect(
    api.put(
      `/competitions/crew-entries/${entry.data.id}`,
      { members: [{ athleteId: created.data.id, role: "ROWER" }] },
      token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
