import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupCompetitionDateFixtures, competitionDatePayload } from "../../fixtures/lib/competitions.js";

// Fase 5.2/5.3/5.4 — competition-date creation (starts DRAFT) + the full
// status transition chain + CANCELLED's restricted reachability.
//
// Status machine (competition-date-status-transition.vo.ts), verified
// against source, not assumed:
//   DRAFT -> PUBLISHED | CANCELLED
//   PUBLISHED -> INSCRIPTION_OPEN | CANCELLED
//   INSCRIPTION_OPEN -> IN_REVIEW
//   IN_REVIEW -> CLOSED | CANCELLED
//   CLOSED -> IN_COMPETITION
//   IN_COMPETITION -> FINAL_RESULTS
//   FINAL_RESULTS, CANCELLED -> [] (terminal)
// Extra rule on top of the table: IN_REVIEW -> CLOSED also requires
// refereePresidentId to already be set on the entity, or it 400s even
// though the transition table itself allows it.

// PATCH .../status responds { success, message } with no `data` (verified
// against competition-date.controller.ts:152) — status is confirmed via a
// follow-up GET, not the transition response itself.
async function transition(id: string, status: string, token: string) {
  return api.patch(`/competitions/competition-dates/${id}/status`, { status }, token);
}

// CompetitionDate.date is unique DB-wide (not per-club) — a random offset
// avoids collisions both across this file's own tests and across repeated
// local runs against a DB that isn't reset each time (CI always starts
// fresh, but local iteration doesn't).
function randomDaysFromNow(): number {
  return 30 + Math.floor(Math.random() * 5000);
}

async function getStatus(id: string, token: string): Promise<string> {
  const res = await api.get<{ data: { status: string } }>(
    `/competitions/competition-dates/${id}`,
    token
  );
  return res.data.status;
}

test("golden path: creates a competition date, starts in DRAFT @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  const fixtures = await setupCompetitionDateFixtures(token);

  const created = await api.post<{ data: { id: string; status: string } }>(
    "/competitions/competition-dates",
    competitionDatePayload(fixtures, randomDaysFromNow()),
    token
  );

  expect(created.data.status).toBe("DRAFT");
});

test.describe.serial("full status chain: DRAFT through FINAL_RESULTS", () => {
  let dateId: string;
  let token: string;

  test.beforeAll(async () => {
    token = await apiLoginAs("REGATTA_COMMISSION");
    const { credentials } = loadFixtures();
    const fixtures = await setupCompetitionDateFixtures(token);

    const created = await api.post<{ data: { id: string } }>(
      "/competitions/competition-dates",
      // refereePresidentId set at creation — IN_REVIEW -> CLOSED requires
      // it already present, and there's no separate endpoint verified for
      // setting it after the fact, so it's simplest to provide it upfront.
      competitionDatePayload(fixtures, randomDaysFromNow(), {
        refereePresidentId: credentials.REFEREE.userId,
      }),
      token
    );
    dateId = created.data.id;
  });

  test("DRAFT -> PUBLISHED @tier0", async () => {
    await transition(dateId, "PUBLISHED", token);
    expect(await getStatus(dateId, token)).toBe("PUBLISHED");
  });

  test("PUBLISHED -> INSCRIPTION_OPEN @tier0", async () => {
    await transition(dateId, "INSCRIPTION_OPEN", token);
    expect(await getStatus(dateId, token)).toBe("INSCRIPTION_OPEN");
  });

  test("INSCRIPTION_OPEN -> IN_REVIEW @tier0", async () => {
    await transition(dateId, "IN_REVIEW", token);
    expect(await getStatus(dateId, token)).toBe("IN_REVIEW");
  });

  test("IN_REVIEW -> CLOSED (refereePresidentId already set) @tier0", async () => {
    await transition(dateId, "CLOSED", token);
    expect(await getStatus(dateId, token)).toBe("CLOSED");
  });

  test("CLOSED -> IN_COMPETITION @tier0", async () => {
    await transition(dateId, "IN_COMPETITION", token);
    expect(await getStatus(dateId, token)).toBe("IN_COMPETITION");
  });

  test("IN_COMPETITION -> FINAL_RESULTS @tier0", async () => {
    await transition(dateId, "FINAL_RESULTS", token);
    expect(await getStatus(dateId, token)).toBe("FINAL_RESULTS");
  });

  test("FINAL_RESULTS is terminal — no further transition allowed @tier0", async () => {
    await expect(transition(dateId, "DRAFT", token)).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<ApiError>);
  });
});

test("IN_REVIEW -> CLOSED fails without a refereePresidentId set @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  const fixtures = await setupCompetitionDateFixtures(token);
  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    competitionDatePayload(fixtures, randomDaysFromNow()), // no refereePresidentId
    token
  );
  const dateId = created.data.id;

  await transition(dateId, "PUBLISHED", token);
  await transition(dateId, "INSCRIPTION_OPEN", token);
  await transition(dateId, "IN_REVIEW", token);

  await expect(transition(dateId, "CLOSED", token)).rejects.toMatchObject({
    status: 400,
  } satisfies Partial<ApiError>);
});

test("CANCELLED is reachable from DRAFT @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  const fixtures = await setupCompetitionDateFixtures(token);
  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    competitionDatePayload(fixtures, randomDaysFromNow()),
    token
  );

  await transition(created.data.id, "CANCELLED", token);
  expect(await getStatus(created.data.id, token)).toBe("CANCELLED");
});

test("CANCELLED is NOT reachable from INSCRIPTION_OPEN @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  const fixtures = await setupCompetitionDateFixtures(token);
  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    competitionDatePayload(fixtures, randomDaysFromNow()),
    token
  );
  const dateId = created.data.id;

  await transition(dateId, "PUBLISHED", token);
  await transition(dateId, "INSCRIPTION_OPEN", token);

  await expect(transition(dateId, "CANCELLED", token)).rejects.toMatchObject({
    status: 400,
  } satisfies Partial<ApiError>);
});
