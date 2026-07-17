import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase 5.9 — race results. PUT crew-entries/:id/result, role
 * requiresRefereeOrRegattaManager() = ADMIN/FEDERATION_ADMIN/
 * REGATTA_COMMISSION/REFEREE (verified against source — CLUB_DELEGATE is
 * NOT in this group, unlike most of the inscription flow).
 *
 * Note: there is no competition-date-status check anywhere in this path
 * (verified: crew-entry.controller.ts's setResult / the repository upsert)
 * — a result can be set at any status, DRAFT included. Not flagged as a
 * "KNOWN GAP" like 5.6/5.7: unlike the submission-lock gaps, allowing
 * provisional/early result entry isn't obviously wrong, just permissive —
 * pinned as ground truth, not asserted as correct or incorrect.
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
  token: string
) {
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    token
  );
}

interface EntryWithResult {
  id: string;
  result: { resultCode: string; position: number | null } | null;
}

// PUT .../result responds { success, message } with no `data` (same shape
// as the status-transition endpoint) — the saved result is confirmed via a
// follow-up GET of the entry list, reading its nested `result` field.
async function getResult(
  fx: Awaited<ReturnType<typeof setupInscriptionFixtures>>,
  entryId: string,
  token: string
) {
  const list = await api.get<{ data: EntryWithResult[] }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    token
  );
  return list.data.find((e) => e.id === entryId)?.result ?? null;
}

test("golden path: REGATTA_COMMISSION sets a FINISHED result @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");

  const entry = await createEntry(fx, club1Token);

  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "3:45.20" },
    regattaToken
  );

  const result = await getResult(fx, entry.data.id, club1Token);
  expect(result?.resultCode).toBe("FINISHED");
  expect(result?.position).toBe(1);
});

test("REFEREE can also set a result @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  const entry = await createEntry(fx, club1Token);

  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "DNS" },
    refereeToken
  );

  const result = await getResult(fx, entry.data.id, club1Token);
  expect(result?.resultCode).toBe("DNS");
});

test("CLUB_DELEGATE cannot set a result @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await createEntry(fx, club1Token);

  await expect(
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1 },
      club1Token
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

// Was "FINISHED result requires a position @tier0" until the Master handicap
// feature (2026-07-16): Masters results are saved progressively — net time
// first, position filled in later by calculate-master-handicap — so
// SetResultSchema no longer requires position for FINISHED at save time.
// The gate moved to ConfirmBlockUseCase instead. This test documents the new
// behavior end to end (was a straight 400 before, see git history).
test("FINISHED result no longer requires a position at save time — the gate moved to confirm-block @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await createEntry(fx, club1Token);

  // Needs a series assigned (like sorteo would) for confirm-block to find it at all.
  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    { refereePresidentId: fx.referee.userId },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: entry.data.id, series: "Final", lane: 1 }] },
    regattaToken
  );

  // Saving FINISHED with no position now succeeds...
  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", time: "3:45.20" },
    regattaToken
  );
  const result = await getResult(fx, entry.data.id, club1Token);
  expect(result?.resultCode).toBe("FINISHED");
  expect(result?.position).toBeNull();

  // ...but confirm-block now refuses to confirm while it's still missing one.
  await expect(
    api.post(
      "/competitions/crew-entries/confirm-block",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("a result can be set while the date is still INSCRIPTION_OPEN, not just IN_COMPETITION @tier0", async () => {
  // setupInscriptionFixtures leaves the date at INSCRIPTION_OPEN (needed to
  // create the entry at all — inscriptions only accept plain creation in
  // that status). Setting a result succeeding here already proves there's
  // no IN_COMPETITION-only guard on this endpoint.
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const entry = await createEntry(fx, club1Token);

  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", position: 1 },
    regattaToken
  );

  const result = await getResult(fx, entry.data.id, club1Token);
  expect(result?.resultCode).toBe("FINISHED");
});
