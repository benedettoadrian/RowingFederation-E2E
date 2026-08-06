import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError, withConflictRetry } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Fase B — referee work posts (Mesa de Llegada / Control de Pista / Lancha)
 * per competition date, with rotation history. Self-assignment or a
 * president/regatta-manager override (same authorization boundary as the
 * crew-change window, see assign-referee-post.use-case.ts).
 */

test("a referee can self-assign a work post @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const assigned = await withConflictRetry(() =>
    api.post<{ data: { post: string; refereeId: string } }>(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: credentials.REFEREE.userId,
        post: "MESA_LLEGADA",
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      refereeToken
    )
  );

  expect(assigned.data.post).toBe("MESA_LLEGADA");
  expect(assigned.data.refereeId).toBe(credentials.REFEREE.userId);
});

test("assigning a non-overlapping post keeps both shifts active, and a same-window post is rejected as overlapping @tier0", async () => {
  // AssignRefereePostUseCase's own docstring is explicit: "a referee's day
  // is a schedule of possibly-several shifts (different posts at different
  // times), not 'one active post' — so this only closes nothing; it just
  // adds a new shift, rejecting it if the referee already has another
  // shift (any post) whose time range overlaps." Verified against source,
  // not assumed — there is no auto-close of a previous open assignment.
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  // Back-to-back shifts (touching boundary at 14:00) — referee-shift-schedule.service.ts
  // treats touching boundaries as non-overlapping, unlike the same window twice.
  await withConflictRetry(() =>
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: credentials.REFEREE.userId,
        post: "CONTROL_PISTA",
        scheduledFrom: "08:00",
        scheduledTo: "14:00",
      },
      refereeToken
    )
  );
  await withConflictRetry(() =>
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: credentials.REFEREE.userId,
        post: "MESA_LLEGADA",
        scheduledFrom: "14:00",
        scheduledTo: "20:00",
      },
      refereeToken
    )
  );

  const active = await api.get<{ data: { post: string; refereeId: string }[] }>(
    `/competitions/referee-work-assignments?competitionDateId=${fx.competitionDateId}&activeOnly=true`,
    refereeToken
  );
  const mine = active.data.filter((a) => a.refereeId === credentials.REFEREE.userId);

  // Both shifts stay active (endedAt: null) — neither auto-closes the other.
  expect(mine).toHaveLength(2);
  expect(mine.map((a) => a.post).sort()).toEqual(["CONTROL_PISTA", "MESA_LLEGADA"]);

  // A third post overlapping either existing shift's window is rejected.
  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: credentials.REFEREE.userId,
        post: "LANCHA",
        launchNumber: 1,
        scheduledFrom: "10:00",
        scheduledTo: "16:00",
      },
      refereeToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("a referee cannot assign a DIFFERENT referee's post without override rights @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: fx.referee.userId,
        post: "LANCHA",
        launchNumber: 1,
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      refereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("REGATTA_COMMISSION can assign a different referee's post @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const assigned = await withConflictRetry(() =>
    api.post<{ data: { post: string; launchNumber: number } }>(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: fx.referee.userId,
        post: "LANCHA",
        launchNumber: 3,
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      regattaToken
    )
  );

  expect(assigned.data.post).toBe("LANCHA");
  expect(assigned.data.launchNumber).toBe(3);
});

test("LANCHA requires a launchNumber @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: fx.referee.userId,
        post: "LANCHA",
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("a non-LANCHA post rejects a launchNumber @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: fx.referee.userId,
        post: "MESA_LLEGADA",
        launchNumber: 1,
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("assigning a non-REFEREE user fails @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      {
        competitionDateId: fx.competitionDateId,
        refereeId: credentials.CLUB_DELEGATE.userId,
        post: "CONTROL_PISTA",
        scheduledFrom: "08:00",
        scheduledTo: "20:00",
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
