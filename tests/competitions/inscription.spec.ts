import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 5.5 (inscription + real-time eligibility), 5.6 (conflict detection —
 * PINS a real gap, not a passing assertion of good behavior), 5.7
 * (submission confirm/unlock — PINS two more gaps), and 3.4 (inscription
 * IDOR, deferred here from Fase 3 since it needed these same fixtures).
 *
 * 5.6 and 5.7's "gap" tests exist because the user explicitly chose
 * (2026-07-10) to document current behavior rather than fix production code
 * in this pass — do not "fix" these tests to expect the ideal behavior
 * without first fixing the backend and getting sign-off; that would make
 * the suite lie about what's actually enforced today.
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
  club: "club1" | "club2",
  token: string,
  overrides: Record<string, unknown> = {}
) {
  const c = fx[club];
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx[club === "club1" ? "club1Id" : "club2Id"],
      members: [{ athleteId: c.athleteId, role: "ROWER" }],
      ...overrides,
    },
    token
  );
}

test("golden path: CLUB_DELEGATE inscribes their own eligible athlete @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const created = await createEntry(fx, "club1", token);
  expect(created.data.id).toBeTruthy();
});

test("rejects inscribing an ineligible (PENDING_APPROVAL) athlete @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // Athlete created without status:"ACTIVE" defaults to PENDING_APPROVAL —
  // isEligibleForCompetition() requires ACTIVE (or a temp override).
  const ineligible = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Ineligible",
      firstSurname: "Athlete",
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `P${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      currentClubId: fx.club1Id,
    },
    adminToken
  );

  await expect(
    api.post(
      "/competitions/crew-entries",
      {
        competitionDateId: fx.competitionDateId,
        eventId: fx.eventId,
        clubId: fx.club1Id,
        members: [{ athleteId: ineligible.data.id, role: "ROWER" }],
      },
      token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("KNOWN GAP (5.6): backend does not reject the same athlete entered in two events on the same competition date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, "club1", token);
  // Same athlete, second event, same date — InscriptionConflictWarningDialog
  // is frontend-only UX; create-crew-entry.use-case.ts has no server-side
  // overlap/conflict check (verified: `proximityWarningAcknowledged` is
  // audit-logged only, never read to gate the request). This currently
  // succeeds — pinning that, not asserting it's correct.
  const second = await createEntry(fx, "club1", token, { eventId: fx.eventId2 });
  expect(second.data.id).toBeTruthy();
});

test("KNOWN GAP (5.7): confirming a submission does not block further create/update/withdraw @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await createEntry(fx, "club1", token);

  const confirmed = await api.post<{ data: { isLocked: boolean } }>(
    "/competitions/crew-entries/submission/confirm",
    { competitionDateId: fx.competitionDateId },
    token
  );
  expect(confirmed.data.isLocked).toBe(true);

  // create-crew-entry/update-crew-entry/withdraw-crew-entry use-cases have
  // no reference to isLocked/submission state (verified via grep) — a
  // "locked" club can still freely create a second entry, update the
  // existing one, or withdraw it. This succeeding is the current (likely
  // unintended) behavior, not a design goal being asserted as correct.
  const second = await createEntry(fx, "club1", token, { eventId: fx.eventId2 });
  expect(second.data.id).toBeTruthy();

  // UpdateCrewEntrySchema requires a full `members` replacement, not a
  // partial patch (lane/series belong to a separate assignment schema) —
  // re-sending the same crew is enough to exercise the update path.
  await api.put(
    `/competitions/crew-entries/${entry.data.id}`,
    { members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }] },
    token
  );
  await api.delete(`/competitions/crew-entries/${entry.data.id}`, token);
});

test("KNOWN GAP (5.7): unlock is self-service by the CLUB_DELEGATE, not admin-restricted @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, "club1", token);
  await api.post(
    "/competitions/crew-entries/submission/confirm",
    { competitionDateId: fx.competitionDateId },
    token
  );

  // requiresClubDelegate() only, per permission.guard.ts:241-244 — the
  // delegate who locked it can unlock it themselves. Original task wording
  // assumed this was admin-only; verified against source it is not.
  const unlocked = await api.post<{ data: { isLocked: boolean } }>(
    "/competitions/crew-entries/submission/unlock",
    { competitionDateId: fx.competitionDateId },
    token
  );
  expect(unlocked.data.isLocked).toBe(false);
});

test("Fase 3.4 — IDOR: CLUB_DELEGATE cannot list another club's inscriptions on the same date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginAs(fx.club2.delegateEmail, fx.club2.delegatePassword);

  await createEntry(fx, "club1", club1Token);

  await expect(
    api.get(
      `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
      club2Token
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("Fase 3.4 — IDOR: CLUB_DELEGATE can list their own club's inscriptions @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await createEntry(fx, "club1", club1Token);

  const list = await api.get<{ data: unknown[] }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  expect(list.data.length).toBeGreaterThan(0);
});
