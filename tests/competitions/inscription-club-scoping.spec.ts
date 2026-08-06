import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Two CLUB_DELEGATE users of the SAME club, and the eligible-athletes picker
 * scoping. Complements inscription.spec.ts's Fase 3.4 IDOR tests (which only
 * cover two DIFFERENT clubs) — verified against get-club-inscriptions.use-case.ts
 * before writing: the scope check is by clubId, not by which user created the
 * entry, so a second delegate of the same club is expected to see everything.
 * get-eligible-athletes.use-case.ts:48 applies the identical clubId-based
 * guard for the athlete picker.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("two CLUB_DELEGATE users of the same club see each other's inscriptions (cross-visible)", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const suffix = randomUUID().slice(0, 8);

  const delegateAToken = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const delegateBEmail = `delegate-b-${suffix}@e2e.test`;
  await api.post(
    "/users",
    {
      email: delegateBEmail,
      password: "E2eTest123",
      firstName: "DelegateB",
      lastName: suffix,
      birthDate: "1990-01-01",
      gender: "MALE",
      role: "CLUB_DELEGATE",
      clubId: fx.club1Id,
    },
    adminToken
  );
  const delegateBToken = await loginAs(delegateBEmail, "E2eTest123");

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    delegateAToken
  );

  // Delegate B (same club, did NOT create this entry) lists club1's inscriptions.
  const list = await api.get<{ data: Array<{ id: string }> }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    delegateBToken
  );
  expect(list.data.some((e) => e.id === entry.data.id)).toBe(true);
});

test("a delegate only sees their own club's athletes when querying eligible athletes for an inscription", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const delegate1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const own = await api.get<{ data: Array<{ athleteId: string }> }>(
    `/competitions/crew-entries/eligible-athletes?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}&clubId=${fx.club1Id}`,
    delegate1Token
  );
  expect(own.data.some((a) => a.athleteId === fx.club1.athleteId)).toBe(true);
  // Never returns the OTHER club's athlete — scoping is server-side (findByClub), not just UI filtering.
  expect(own.data.some((a) => a.athleteId === fx.club2.athleteId)).toBe(false);

  await expect(
    api.get(
      `/competitions/crew-entries/eligible-athletes?competitionDateId=${fx.competitionDateId}&eventId=${fx.eventId}&clubId=${fx.club2Id}`,
      delegate1Token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
