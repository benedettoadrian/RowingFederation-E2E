import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Master handicap feature (2026-07-16) — full flow through the real stack:
 * save net time (no position yet) -> POST calculate-master-handicap ->
 * confirm-block. Uses setupInscriptionFixtures({ isMaster: true, ... }) with
 * two athletes of different ages so the handicap math actually does
 * something observable (same-age crews would all get handicap 0).
 */

async function loginAs(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

// upsertResult runs inside a Serializable transaction (crew-entry.repository.impl.ts)
// so it can abort with a "CONFLICT: transaction conflict, please retry" 400 under
// concurrent load on the crew_entry_results table — expected/documented behavior,
// the client is meant to retry, not a sign either request was wrong.
async function putResultWithRetry(
  path: string,
  body: unknown,
  token: string,
  attempts = 5
): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await api.put(path, body, token);
    } catch (error) {
      const isLastAttempt = i === attempts - 1;
      const isConflict = error instanceof ApiError && error.status === 400 && /CONFLICT/.test(String(error.body));
      if (!isConflict || isLastAttempt) throw error;
      // Small backoff so a still-in-flight contending transaction has time to
      // clear before the next attempt, instead of retrying back-to-back into
      // the same collision under sustained parallel load.
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

interface EntryWithMasterResult {
  id: string;
  result: {
    resultCode: string;
    position: number | null;
    time: string | null;
    averageAge: number | null;
    handicapSeconds: number | null;
    officialTime: string | null;
    resultSource: string | null;
    confirmedAt: string | null;
  } | null;
}

async function getEntries(competitionDateId: string, clubId: string, token: string) {
  const list = await api.get<{ data: EntryWithMasterResult[] }>(
    `/competitions/crew-entries?competitionDateId=${competitionDateId}&clubId=${clubId}`,
    token
  );
  return list.data;
}

async function setupMasterRace(adminToken: string, regattaToken: string) {
  // setupInscriptionFixtures's default random competition date can land
  // centuries out (avoids CompetitionDate.date's DB-wide unique constraint
  // colliding across the whole suite) — fine for tests that don't care what
  // the date actually is, but useless here: athlete creation validates
  // birthdate against REAL today ("at least 7 years old"), while FISA age
  // for the handicap is computed against the competition date's year. A
  // birthdate old enough for a 53-year-old Master rower relative to a
  // centuries-out competition date would be centuries in the future relative
  // to real "today" — rejected outright. Use a much narrower near-term
  // window instead (own entropy, not the shared helper's) — enough to avoid
  // colliding with the wide-range tests' dates, small enough that the
  // resulting year stays realistic for a real athlete's birthdate.
  const daysFromNow = 30 + Math.floor(Math.random() * 3000);
  const competitionDate = new Date();
  competitionDate.setUTCDate(competitionDate.getUTCDate() + daysFromNow);
  competitionDate.setUTCHours(0, 0, 0, 0);
  const competitionYear = competitionDate.getUTCFullYear();

  // dateOverrides.date alone isn't enough — setupInscriptionFixtures draws
  // its own independent random daysFromNow internally to build
  // inscriptionOpenAt/inscriptionCloseAt, which would then disagree with our
  // own competitionDate above (backend rejects a close date that lands after
  // the competition day). Override all three together, mirroring
  // competitionDatePayload()'s own math exactly.
  const inscriptionOpenAt = new Date();
  inscriptionOpenAt.setUTCDate(inscriptionOpenAt.getUTCDate() + 1);
  const inscriptionCloseAt = new Date(competitionDate);
  inscriptionCloseAt.setUTCDate(inscriptionCloseAt.getUTCDate() - 1);
  inscriptionCloseAt.setUTCHours(23, 0, 0, 0);

  // club1 athlete: FISA age 53. club2 athlete: FISA age 63 -> 10 years older
  // -> 10s handicap.
  const fx = await setupInscriptionFixtures(adminToken, {
    isMaster: true,
    dateOverrides: {
      date: competitionDate.toISOString(),
      inscriptionOpenAt: inscriptionOpenAt.toISOString(),
      inscriptionCloseAt: inscriptionCloseAt.toISOString(),
    },
    club1AthleteBirthdate: `${competitionYear - 53}-01-01`,
    club2AthleteBirthdate: `${competitionYear - 63}-01-01`,
  });

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

  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      // IN_REVIEW -> CLOSED also requires both crew-change-window fields
      // set (competition-date-status.service.ts), same gate as referee.
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    {
      assignments: [
        { entryId: entry1.data.id, series: "Final", lane: 1 },
        { entryId: entry2.data.id, series: "Final", lane: 2 },
      ],
    },
    regattaToken
  );

  return { fx, entry1, entry2, club1Token, club2Token };
}

test("golden path: save net times -> calculate handicap -> confirm block, older crew's handicap can flip the placing @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { fx, entry1, entry2, club1Token, club2Token } = await setupMasterRace(adminToken, regattaToken);

  // entry1 (age 53, handicap 0) is nominally faster on the clock than
  // entry2 (age 63, handicap 10s) — but 10s of handicap flips the placing:
  // entry2's official time (4:15.00 - 10s = 4:05.00) beats entry1's 4:10.00.
  await putResultWithRetry(
    `/competitions/crew-entries/${entry1.data.id}/result`,
    { resultCode: "FINISHED", time: "4:10.00" },
    regattaToken
  );
  await putResultWithRetry(
    `/competitions/crew-entries/${entry2.data.id}/result`,
    { resultCode: "FINISHED", time: "4:15.00" },
    regattaToken
  );

  const calc = await api.post<{ success: boolean; updated: number }>(
    "/competitions/crew-entries/calculate-master-handicap",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
  expect(calc.updated).toBe(2);

  const entries = await getEntries(fx.competitionDateId, fx.club1Id, club1Token);
  const result1 = entries.find((e) => e.id === entry1.data.id)?.result;
  expect(result1).toMatchObject({ averageAge: 53, handicapSeconds: 0, officialTime: "4:10.00", position: 2, resultSource: "AUTO" });

  const entries2 = await getEntries(fx.competitionDateId, fx.club2Id, club2Token);
  const result2 = entries2.find((e) => e.id === entry2.data.id)?.result;
  expect(result2).toMatchObject({ averageAge: 63, handicapSeconds: 10, officialTime: "4:05.00", position: 1, resultSource: "AUTO" });

  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
  const confirmed = await getEntries(fx.competitionDateId, fx.club1Id, club1Token);
  expect(confirmed.find((e) => e.id === entry1.data.id)?.result?.confirmedAt).not.toBeNull();
});

test("calculate-master-handicap refuses to recalculate an already-confirmed block @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { fx, entry1, entry2 } = await setupMasterRace(adminToken, regattaToken);

  await putResultWithRetry(`/competitions/crew-entries/${entry1.data.id}/result`, { resultCode: "FINISHED", time: "4:10.00" }, regattaToken);
  await putResultWithRetry(`/competitions/crew-entries/${entry2.data.id}/result`, { resultCode: "FINISHED", time: "4:15.00" }, regattaToken);

  await api.post(
    "/competitions/crew-entries/calculate-master-handicap",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );
  await api.post(
    "/competitions/crew-entries/confirm-block",
    { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
    regattaToken
  );

  await expect(
    api.post(
      "/competitions/crew-entries/calculate-master-handicap",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("calculate-master-handicap rejects a non-Masters event @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  // Default (non-Master) fixtures.
  const fx = await setupInscriptionFixtures(adminToken);
  const club1Token = await loginAs(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
    },
    club1Token
  );
  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      // IN_REVIEW -> CLOSED also requires both crew-change-window fields
      // set (competition-date-status.service.ts), same gate as referee.
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: entry.data.id, series: "Final", lane: 1 }] },
    regattaToken
  );
  await putResultWithRetry(`/competitions/crew-entries/${entry.data.id}/result`, { resultCode: "FINISHED", time: "4:10.00" }, regattaToken);

  await expect(
    api.post(
      "/competitions/crew-entries/calculate-master-handicap",
      { competitionDateId: fx.competitionDateId, eventId: fx.eventId, series: "Final" },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
