import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase C — live operations (Control de Pista / Lancha / Mesa de Llegada).
 *
 * RaceExecution rows only exist once a competition date has crew entries
 * with a `series` assigned (via sorteo/confirm) AND has transitioned all the
 * way to CLOSED (PopulateRaceExecutionsUseCase runs as a best-effort side
 * effect of that specific transition) — so every test here builds the full
 * chain itself: inscribe -> set refereePresident/crewChangeWindow -> IN_REVIEW
 * -> sorteo/confirm (explicit series="Final", matching hasHeats:false) ->
 * CLOSED. Mirrors the exact sequence already established in
 * master-handicap.spec.ts's `setupMasterRace`.
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", { email, password });
  return res.data.accessToken;
}

/**
 * claim/card/assign run inside Serializable transactions — under Postgres's
 * SSI, a page-level predicate lock can produce a false-positive 409 between
 * transactions that don't even share application-level rows, especially on
 * a small table hammered by many parallel Playwright workers across
 * unrelated test files. A real client retries on 409 (that's the whole
 * point of surfacing it as retry-safe); do the same here for calls that
 * aren't themselves testing the race condition.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && i < attempts - 1) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

/**
 * For the "exactly one wins" tests below: the same SSI false-conflict risk
 * described above can, rarely, take out BOTH sides of the intentional 2-way
 * race at once (0 fulfilled) instead of exactly one — an unrelated
 * transaction elsewhere in the suite loses to both, rather than either side
 * losing to the other. Nothing commits when that happens, so the whole race
 * is safe to replay. `makeCalls` is a thunk (not the promises themselves) so
 * a retry re-issues fresh requests instead of re-awaiting settled ones.
 */
async function raceExactlyOneWins<T>(
  makeCalls: () => Promise<T>[],
  attempts = 2
): Promise<PromiseSettledResult<T>[]> {
  let results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < attempts; i++) {
    results = await Promise.allSettled(makeCalls());
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    if (fulfilled.length > 0 || i === attempts - 1) return results;
  }
  return results;
}

async function createReferee(adminToken: string, label: string) {
  const email = `referee-${label}@e2e.test`;
  const password = "E2eTest123";
  const created = await api.post<{ data: { id: string } }>(
    "/users",
    {
      email,
      password,
      firstName: "Referee",
      lastName: label,
      birthDate: "1980-01-01",
      gender: "MALE",
      role: "REFEREE",
    },
    adminToken
  );
  const token = await loginAs(email, password);
  return { userId: created.data.id, email, password, token };
}

async function assignPost(
  regattaToken: string,
  competitionDateId: string,
  refereeId: string,
  post: "MESA_LLEGADA" | "CONTROL_PISTA" | "LANCHA",
  launchNumber?: number
) {
  // scheduledFrom/scheduledTo became required by referee-shift-schedule
  // (20260728142815_add_referee_shift_schedule) — a wide window covering a
  // full competition day, since these tests don't exercise shift-overlap
  // rules themselves (that's referee-work-assignments.spec.ts's job).
  await api.post(
    "/competitions/referee-work-assignments",
    {
      competitionDateId,
      refereeId,
      post,
      scheduledFrom: "08:00",
      scheduledTo: "20:00",
      ...(launchNumber !== undefined ? { launchNumber } : {}),
    },
    regattaToken
  );
}

interface RaceExecutionRow {
  id: string;
  eventId: string;
  series: string;
  status: string;
  claimedByRefereeId: string | null;
  startedAt: string | null;
}

/**
 * Two boats (club1, club2) in the same event/series ("Final", carriles 1/2)
 * plus a third boat (club1) in a SECOND event/series — the second race is
 * what lets the "only one race IN_PROGRESS per date" tests exercise the
 * actual cross-row invariant instead of a single-row CAS.
 */
async function setupLiveRace(regattaToken: string) {
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginAs(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const entry1 = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );
  const entry2 = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club2Id,
      members: [{ athleteId: fx.club2.athleteId, role: "ROWER" }],
    },
    club2Token
  );
  const entry3 = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId2,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );

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
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: entry1.data.id, series: "Final", lane: 1 },
        { entryId: entry2.data.id, series: "Final", lane: 2 },
        { entryId: entry3.data.id, series: "Final", lane: 1 },
      ],
    },
    regattaToken
  );
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  const races = await api.get<{ data: RaceExecutionRow[] }>(
    `/competitions/race-executions?competitionDateId=${fx.competitionDateId}`,
    regattaToken
  );
  const raceA = races.data.find((r) => r.eventId === fx.eventId)!;
  const raceB = races.data.find((r) => r.eventId === fx.eventId2)!;
  expect(raceA, "race A (fx.eventId) should exist after CLOSED").toBeTruthy();
  expect(raceB, "race B (fx.eventId2) should exist after CLOSED").toBeTruthy();

  return { adminToken, regattaToken, fx, entry1, entry2, entry3, club1Token, club2Token, raceA, raceB };
}

// ── Control de Pista (C7) ──────────────────────────────────────────────────

test("Control de Pista can authorize a boat @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, raceA } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `cp-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "CONTROL_PISTA");

  const result = await api.post<{ data: { decision: string } }>(
    "/competitions/lane-control-checks",
    { crewEntryId: entry1.data.id, raceExecutionId: raceA.id, decision: "AUTHORIZED" },
    referee.token
  );
  expect(result.data.decision).toBe("AUTHORIZED");
});

test("Control de Pista rejection for safety requires notes and excludes the boat via DSQ @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, entry1, raceA, fx, club1Token } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `cps-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "CONTROL_PISTA");

  await expect(
    api.post(
      "/competitions/lane-control-checks",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id, decision: "REJECTED_SAFETY" },
      referee.token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);

  await api.post(
    "/competitions/lane-control-checks",
    {
      crewEntryId: entry1.data.id,
      raceExecutionId: raceA.id,
      decision: "REJECTED_SAFETY",
      notes: "Falta chaleco",
    },
    referee.token
  );

  const entries = await api.get<{ data: { id: string; result?: { resultCode: string } }[] }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  expect(entries.data.find((e) => e.id === entry1.data.id)?.result?.resultCode).toBe("DSQ");
});

test("a referee without an active CONTROL_PISTA assignment cannot register a check @tier0" , async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, entry1, raceA } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `cpx-${randomUUID().slice(0, 6)}`);

  await expect(
    api.post(
      "/competitions/lane-control-checks",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id, decision: "AUTHORIZED" },
      referee.token
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

// ── Lancha: tomar / largar / finalizar (C9-C10) ────────────────────────────

test("Lancha can claim, largar, and finish a race @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, raceA } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `lc-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "LANCHA", 1);

  const claimed = await withRetry(() =>
    api.post<{ data: { status: string } }>(`/competitions/race-executions/${raceA.id}/claim`, {}, referee.token)
  );
  expect(claimed.data.status).toBe("IN_PROGRESS");

  const started = await api.post<{ data: { startedAt: string } }>(
    `/competitions/race-executions/${raceA.id}/start`,
    {},
    referee.token
  );
  expect(started.data.startedAt).toBeTruthy();

  const finished = await api.post<{ data: { endedAt: string } }>(
    `/competitions/race-executions/${raceA.id}/finish`,
    {},
    referee.token
  );
  expect(finished.data.endedAt).toBeTruthy();
});

test("only one race can be IN_PROGRESS per competition date at a time @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, raceA, raceB } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `lc2-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "LANCHA", 1);

  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, referee.token));

  // A business-rule 409 ("another race already in progress") — genuinely
  // not retry-safe (retrying wouldn't change the outcome while raceA holds
  // the slot), unlike the transaction-conflict 409s elsewhere in this file.
  await expect(
    api.post(`/competitions/race-executions/${raceB.id}/claim`, {}, referee.token)
  ).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);

  // Freeing race A (finish) must let race B be claimed afterward.
  await api.post(`/competitions/race-executions/${raceA.id}/finish`, {}, referee.token);
  const claimedB = await withRetry(() =>
    api.post<{ data: { status: string } }>(`/competitions/race-executions/${raceB.id}/claim`, {}, referee.token)
  );
  expect(claimedB.data.status).toBe("IN_PROGRESS");
});

// ── Concurrency: claiming (C9) ──────────────────────────────────────────────

test("two lanchas racing to claim the SAME race — exactly one wins @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, raceA } = await setupLiveRace(regattaToken);
  const refereeX = await createReferee(adminToken, `cx-${randomUUID().slice(0, 6)}`);
  const refereeY = await createReferee(adminToken, `cy-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, refereeX.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, refereeY.userId, "LANCHA", 2);

  const results = await raceExactlyOneWins(() => [
    api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, refereeX.token),
    api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, refereeY.token),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const rejection = (rejected[0] as PromiseRejectedResult).reason as ApiError;
  expect([400, 409]).toContain(rejection.status);
});

test("two lanchas racing to claim TWO DIFFERENT races on the same date — exactly one wins @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, raceA, raceB } = await setupLiveRace(regattaToken);
  const refereeX = await createReferee(adminToken, `dx-${randomUUID().slice(0, 6)}`);
  const refereeY = await createReferee(adminToken, `dy-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, refereeX.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, refereeY.userId, "LANCHA", 2);

  const results = await raceExactlyOneWins(() => [
    api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, refereeX.token),
    api.post(`/competitions/race-executions/${raceB.id}/claim`, {}, refereeY.token),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const rejection = (rejected[0] as PromiseRejectedResult).reason as ApiError;
  expect([400, 409]).toContain(rejection.status);

  const races = await api.get<{ data: RaceExecutionRow[] }>(
    `/competitions/race-executions?competitionDateId=${fx.competitionDateId}`,
    regattaToken
  );
  const inProgressCount = races.data.filter((r) => r.status === "IN_PROGRESS").length;
  expect(inProgressCount).toBe(1);
});

// ── Tarjetas (C8) ────────────────────────────────────────────────────────

test("a second card on the same boat auto-excludes it via DSQ @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, raceA, club1Token } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `card-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "LANCHA", 1);

  const first = await withRetry(() =>
    api.post<{ data: { cardCount: number; excluded: boolean } }>(
      "/competitions/crew-entry-cards",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id },
      referee.token
    )
  );
  expect(first.data).toMatchObject({ cardCount: 1, excluded: false });

  const second = await withRetry(() =>
    api.post<{ data: { cardCount: number; excluded: boolean } }>(
      "/competitions/crew-entry-cards",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id },
      referee.token
    )
  );
  expect(second.data).toMatchObject({ cardCount: 2, excluded: true });

  const entries = await api.get<{ data: { id: string; result?: { resultCode: string } }[] }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  expect(entries.data.find((e) => e.id === entry1.data.id)?.result?.resultCode).toBe("DSQ");
});

test("two referees carding the same boat simultaneously — the exclusion is never lost @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, raceA, club1Token } = await setupLiveRace(regattaToken);
  const refereeX = await createReferee(adminToken, `ccx-${randomUUID().slice(0, 6)}`);
  const refereeY = await createReferee(adminToken, `ccy-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, refereeX.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, refereeY.userId, "LANCHA", 2);

  const results = await Promise.allSettled([
    api.post<{ data: { cardCount: number; excluded: boolean } }>(
      "/competitions/crew-entry-cards",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id },
      refereeX.token
    ),
    api.post<{ data: { cardCount: number; excluded: boolean } }>(
      "/competitions/crew-entry-cards",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id },
      refereeY.token
    ),
  ]);

  // The Serializable transaction protects the count invariant by sometimes
  // rejecting the LOSER of a genuine write-write race with a 409 (safe to
  // retry) rather than letting it silently observe a stale count — it must
  // never let both requests see count=1 (which would silently lose the
  // 2nd-card exclusion). A real client retries on 409; simulate that here.
  let sawExcluded = false;
  for (const r of results) {
    if (r.status === "fulfilled") {
      sawExcluded = sawExcluded || r.value.data.excluded;
    } else {
      expect((r.reason as ApiError).status).toBe(409);
      const retried = await api.post<{ data: { cardCount: number; excluded: boolean } }>(
        "/competitions/crew-entry-cards",
        { crewEntryId: entry1.data.id, raceExecutionId: raceA.id },
        refereeX.token
      );
      sawExcluded = sawExcluded || retried.data.excluded;
    }
  }
  expect(sawExcluded).toBe(true);

  const entries = await api.get<{ data: { id: string; result?: { resultCode: string } }[] }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  expect(entries.data.find((e) => e.id === entry1.data.id)?.result?.resultCode).toBe("DSQ");
});

// ── Mesa de Llegada (C11-C12) ───────────────────────────────────────────────

test("Mesa de Llegada captures marks in order and assigns them, computing position and time @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, entry2, raceA, club1Token } = await setupLiveRace(regattaToken);
  const lancha = await createReferee(adminToken, `mlA-${randomUUID().slice(0, 6)}`);
  const mesa = await createReferee(adminToken, `mlB-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, lancha.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, mesa.userId, "MESA_LLEGADA");

  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, lancha.token));
  await api.post(`/competitions/race-executions/${raceA.id}/start`, {}, lancha.token);

  const mark1 = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesa.token
  );
  await new Promise((r) => setTimeout(r, 1100));
  const mark2 = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesa.token
  );

  const assign1 = await withRetry(() =>
    api.post<{ data: { position: number; time: string } }>(
      `/competitions/finish-marks/${mark1.data.id}/assign`,
      { crewEntryId: entry1.data.id },
      mesa.token
    )
  );
  const assign2 = await withRetry(() =>
    api.post<{ data: { position: number; time: string } }>(
      `/competitions/finish-marks/${mark2.data.id}/assign`,
      { crewEntryId: entry2.data.id },
      mesa.token
    )
  );

  expect(assign1.data.position).toBe(1);
  expect(assign2.data.position).toBe(2);
  expect(assign1.data.time).toMatch(/^\d{1,3}:\d{2}\.\d{2}$/);
  expect(assign2.data.time).toMatch(/^\d{1,3}:\d{2}\.\d{2}$/);

  const entries = await api.get<{
    data: { id: string; result?: { resultCode: string; position: number } }[];
  }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  expect(entries.data.find((e) => e.id === entry1.data.id)?.result).toMatchObject({
    resultCode: "FINISHED",
    position: 1,
  });
});

// ── Concurrency: finish marks (C11-C12) ─────────────────────────────────────

test("two mesa de llegada referees assigning the SAME mark to different boats — exactly one wins @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, entry2, raceA } = await setupLiveRace(regattaToken);
  const lancha = await createReferee(adminToken, `fmA-${randomUUID().slice(0, 6)}`);
  const mesaX = await createReferee(adminToken, `fmX-${randomUUID().slice(0, 6)}`);
  const mesaY = await createReferee(adminToken, `fmY-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, lancha.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, mesaX.userId, "MESA_LLEGADA");
  await assignPost(regattaToken, fx.competitionDateId, mesaY.userId, "MESA_LLEGADA");

  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, lancha.token));
  await api.post(`/competitions/race-executions/${raceA.id}/start`, {}, lancha.token);
  const mark = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesaX.token
  );

  const results = await raceExactlyOneWins(() => [
    api.post(`/competitions/finish-marks/${mark.data.id}/assign`, { crewEntryId: entry1.data.id }, mesaX.token),
    api.post(`/competitions/finish-marks/${mark.data.id}/assign`, { crewEntryId: entry2.data.id }, mesaY.token),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const rejection = (rejected[0] as PromiseRejectedResult).reason as ApiError;
  expect([409].includes(rejection.status) || rejection.status === 400).toBe(true);
});

test("two mesa de llegada referees assigning DIFFERENT marks to the SAME boat — exactly one wins @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, raceA } = await setupLiveRace(regattaToken);
  const lancha = await createReferee(adminToken, `fbA-${randomUUID().slice(0, 6)}`);
  const mesaX = await createReferee(adminToken, `fbX-${randomUUID().slice(0, 6)}`);
  const mesaY = await createReferee(adminToken, `fbY-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, lancha.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, mesaX.userId, "MESA_LLEGADA");
  await assignPost(regattaToken, fx.competitionDateId, mesaY.userId, "MESA_LLEGADA");

  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, lancha.token));
  await api.post(`/competitions/race-executions/${raceA.id}/start`, {}, lancha.token);
  const markA = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesaX.token
  );
  await new Promise((r) => setTimeout(r, 1100));
  const markB = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesaX.token
  );

  const results = await raceExactlyOneWins(() => [
    api.post(`/competitions/finish-marks/${markA.data.id}/assign`, { crewEntryId: entry1.data.id }, mesaX.token),
    api.post(`/competitions/finish-marks/${markB.data.id}/assign`, { crewEntryId: entry1.data.id }, mesaY.token),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
});

// ── Concurrency: result overwrite across Control de Pista / Mesa de Llegada ──

test("Mesa de Llegada assigning FINISHED and Control de Pista rejecting the same boat at nearly the same time — result ends up consistent, never corrupted @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, entry1, raceA, club1Token } = await setupLiveRace(regattaToken);
  const lancha = await createReferee(adminToken, `xrA-${randomUUID().slice(0, 6)}`);
  const mesa = await createReferee(adminToken, `xrB-${randomUUID().slice(0, 6)}`);
  const pista = await createReferee(adminToken, `xrC-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, lancha.userId, "LANCHA", 1);
  await assignPost(regattaToken, fx.competitionDateId, mesa.userId, "MESA_LLEGADA");
  await assignPost(regattaToken, fx.competitionDateId, pista.userId, "CONTROL_PISTA");

  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, lancha.token));
  await api.post(`/competitions/race-executions/${raceA.id}/start`, {}, lancha.token);
  const mark = await api.post<{ data: { id: string } }>(
    "/competitions/finish-marks",
    { raceExecutionId: raceA.id },
    mesa.token
  );

  // Mesa assigns the mark (writes FINISHED) and Control de Pista rejects the
  // same boat (writes DSQ) at nearly the same time — both go through
  // upsertResult's Serializable transaction on the same CrewEntryResult row.
  // Whichever loses must surface as a retry-safe 409, never a silent/lost
  // write, and the row must never end up in a corrupted mixed state.
  const results = await raceExactlyOneWins(() => [
    api.post<{ data: { position: number } }>(
      `/competitions/finish-marks/${mark.data.id}/assign`,
      { crewEntryId: entry1.data.id },
      mesa.token
    ),
    api.post(
      "/competitions/lane-control-checks",
      { crewEntryId: entry1.data.id, raceExecutionId: raceA.id, decision: "REJECTED_LATE" },
      pista.token
    ),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      expect((r.reason as ApiError).status).toBe(409);
    }
  }
  const successCount = results.filter((r) => r.status === "fulfilled").length;
  expect(successCount).toBeGreaterThanOrEqual(1);

  const entries = await api.get<{
    data: { id: string; result?: { resultCode: string } }[];
  }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  const finalResult = entries.data.find((e) => e.id === entry1.data.id)?.result;
  expect(finalResult).toBeTruthy();
  expect(["FINISHED", "DSQ"]).toContain(finalResult!.resultCode);
});

// ── Public + authenticated listings (C13-C14) ───────────────────────────────

test("public race-executions listing hides referee-facing fields @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { fx } = await setupLiveRace(regattaToken);

  // Manually forcing CLOSED -> IN_COMPETITION is ADMIN-only (competition-date.controller.ts:217).
  const adminToken = await apiLoginAs("ADMIN");
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_COMPETITION" },
    adminToken
  );

  const publicRes = await api.get<{ data: { eventId: string; series: string; status: string }[] }>(
    `/competitions/race-executions/public?competitionDateId=${fx.competitionDateId}`
  );
  const publicRace = publicRes.data.find((r) => r.eventId === fx.eventId && r.series === "Final");
  expect(publicRace).toBeTruthy();
  expect(publicRace).not.toHaveProperty("id");
  expect(publicRace).not.toHaveProperty("claimedByRefereeId");
});

test("authenticated race-executions listing exposes id and claim info @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { adminToken, fx, raceA } = await setupLiveRace(regattaToken);
  const referee = await createReferee(adminToken, `list-${randomUUID().slice(0, 6)}`);
  await assignPost(regattaToken, fx.competitionDateId, referee.userId, "LANCHA", 1);
  await withRetry(() => api.post(`/competitions/race-executions/${raceA.id}/claim`, {}, referee.token));

  const listRes = await api.get<{
    data: { id: string; claimedByRefereeId: string | null; claimedByRefereeName: string | null }[];
  }>(`/competitions/race-executions?competitionDateId=${fx.competitionDateId}`, referee.token);

  const race = listRes.data.find((r) => r.id === raceA.id);
  expect(race?.claimedByRefereeId).toBe(referee.userId);
  expect(race?.claimedByRefereeName).toBeTruthy();
});
