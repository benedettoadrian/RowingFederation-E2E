import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError, withConflictRetry } from "../../fixtures/lib/api.js";
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
//
// A CLUB_DELEGATE's own club view (GET /crew-entries?clubId=) waits for the
// date's president to confirm the block — same rule as the public feed,
// confirmed explicitly with the business owner: a delegate must not see
// their own boat's result before it's official. So this only works for an
// ALREADY-CONFIRMED result; use getResultAsReferee below to check a result
// that was just saved but not yet confirmed.
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

// GET /crew-entries/all is the referee/regatta-manager working view — always
// raw, never confirmedAt-gated (that gate exists for the public/delegate
// feeds, not the people actually running the competition). Use this to
// verify a result was saved correctly before/without confirming its block.
async function getResultAsReferee(
  fx: Awaited<ReturnType<typeof setupInscriptionFixtures>>,
  entryId: string,
  token: string
) {
  const list = await api.get<{ data: EntryWithResult[] }>(
    `/competitions/crew-entries/all?competitionDateId=${fx.competitionDateId}`,
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

  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1, time: "3:45.20" },
      regattaToken
    )
  );

  const result = await getResultAsReferee(fx, entry.data.id, regattaToken);
  expect(result?.resultCode).toBe("FINISHED");
  expect(result?.position).toBe(1);
});

test("REFEREE can also set a result @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  const entry = await createEntry(fx, club1Token);

  await withConflictRetry(() =>
    api.put(`/competitions/crew-entries/${entry.data.id}/result`, { resultCode: "DNS" }, refereeToken)
  );

  const result = await getResultAsReferee(fx, entry.data.id, refereeToken);
  expect(result?.resultCode).toBe("DNS");
});

test("a CLUB_DELEGATE cannot see their own boat's result until the president confirms the block @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await createEntry(fx, club1Token);
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1, time: "3:45.20" },
      regattaToken
    )
  );

  // Saved and visible to a referee/regatta manager (the working view)...
  const asReferee = await getResultAsReferee(fx, entry.data.id, regattaToken);
  expect(asReferee?.resultCode).toBe("FINISHED");

  // ...but the delegate — even for their own club's own boat — sees nothing
  // until the date's president confirms the block. Same rule as the public
  // feed; confirmed explicitly with the business owner.
  const asDelegate = await getResult(fx, entry.data.id, club1Token);
  expect(asDelegate).toBeNull();
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
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", time: "3:45.20" },
      regattaToken
    )
  );
  const result = await getResultAsReferee(fx, entry.data.id, regattaToken);
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

  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1 },
      regattaToken
    )
  );

  const result = await getResultAsReferee(fx, entry.data.id, regattaToken);
  expect(result?.resultCode).toBe("FINISHED");
});

/**
 * Referee-president exclusivity — publishing (confirm-block / finalize the
 * date) is gated to the referee assigned as CompetitionDate.refereePresidentId,
 * plus regatta managers. Any referee can view/load results (GET .../all,
 * PUT .../result) — that part stays open to the whole role, see the tests
 * above. Ownership is enforced in ConfirmBlockUseCase and
 * CompetitionDateController.transitionStatus (not in the route guard, which
 * only checks role).
 */

test("REFEREE can list all inscriptions for a competition date (GET .../all) @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  const res = await api.get(
    `/competitions/crew-entries/all?competitionDateId=${fx.competitionDateId}`,
    refereeToken
  );
  expect(res).toBeTruthy();
});

test("the assigned referee president can confirm a block @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  const entry = await createEntry(fx, club1Token);
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
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1, time: "3:45.20" },
      regattaToken
    )
  );

  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    refereeToken
  );

  const result = await getResult(fx, entry.data.id, club1Token);
  expect(result?.resultCode).toBe("FINISHED");
});

test("a referee who is NOT the assigned president cannot confirm a block @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  // The generic seeded REFEREE account — a different user than fx.referee,
  // which is the one about to be assigned as president below.
  const otherRefereeToken = await apiLoginAs("REFEREE");

  const entry = await createEntry(fx, club1Token);
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
  await withConflictRetry(() =>
    api.put(
      `/competitions/crew-entries/${entry.data.id}/result`,
      { resultCode: "FINISHED", position: 1, time: "3:45.20" },
      regattaToken
    )
  );

  await expect(
    api.post(
      "/competitions/crew-entries/confirm-block",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
      otherRefereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("the assigned referee president can finalize the competition date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { advanceToClosed: true });
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  // Manually forcing CLOSED -> IN_COMPETITION is ADMIN-only (competition-date.controller.ts:217).
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_COMPETITION" },
    adminToken
  );

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "FINAL_RESULTS" },
    refereeToken
  );
});

test("a referee who is NOT the assigned president cannot finalize the competition date @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken, { advanceToClosed: true });
  const otherRefereeToken = await apiLoginAs("REFEREE");

  // Manually forcing CLOSED -> IN_COMPETITION is ADMIN-only (competition-date.controller.ts:217).
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_COMPETITION" },
    adminToken
  );

  await expect(
    api.patch(
      `/competitions/competition-dates/${fx.competitionDateId}/status`,
      { status: "FINAL_RESULTS" },
      otherRefereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("a referee cannot perform non-finalize status transitions, even as the assigned president @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(adminToken);
  const refereeToken = await loginAs(fx.referee.email, fx.referee.password);

  await expect(
    api.patch(
      `/competitions/competition-dates/${fx.competitionDateId}/status`,
      { status: "IN_REVIEW" },
      refereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});
