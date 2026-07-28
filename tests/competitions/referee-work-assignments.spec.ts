import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
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

  const assigned = await api.post<{ data: { post: string; refereeId: string } }>(
    "/competitions/referee-work-assignments",
    {
      competitionDateId: fx.competitionDateId,
      refereeId: credentials.REFEREE.userId,
      post: "MESA_LLEGADA",
    },
    refereeToken
  );

  expect(assigned.data.post).toBe("MESA_LLEGADA");
  expect(assigned.data.refereeId).toBe(credentials.REFEREE.userId);
});

test("assigning a new post closes the referee's previous open assignment @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await api.post(
    "/competitions/referee-work-assignments",
    { competitionDateId: fx.competitionDateId, refereeId: credentials.REFEREE.userId, post: "CONTROL_PISTA" },
    refereeToken
  );
  await api.post(
    "/competitions/referee-work-assignments",
    { competitionDateId: fx.competitionDateId, refereeId: credentials.REFEREE.userId, post: "MESA_LLEGADA" },
    refereeToken
  );

  const active = await api.get<{ data: { post: string; refereeId: string }[] }>(
    `/competitions/referee-work-assignments?competitionDateId=${fx.competitionDateId}&activeOnly=true`,
    refereeToken
  );
  const mine = active.data.filter((a) => a.refereeId === credentials.REFEREE.userId);

  expect(mine).toHaveLength(1);
  expect(mine[0]!.post).toBe("MESA_LLEGADA");

  const history = await api.get<{ data: { refereeId: string }[] }>(
    `/competitions/referee-work-assignments?competitionDateId=${fx.competitionDateId}&activeOnly=false`,
    refereeToken
  );
  expect(history.data.filter((a) => a.refereeId === credentials.REFEREE.userId)).toHaveLength(2);
});

test("a referee cannot assign a DIFFERENT referee's post without override rights @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await expect(
    api.post(
      "/competitions/referee-work-assignments",
      { competitionDateId: fx.competitionDateId, refereeId: fx.referee.userId, post: "LANCHA", launchNumber: 1 },
      refereeToken
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("REGATTA_COMMISSION can assign a different referee's post @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const assigned = await api.post<{ data: { post: string; launchNumber: number } }>(
    "/competitions/referee-work-assignments",
    {
      competitionDateId: fx.competitionDateId,
      refereeId: fx.referee.userId,
      post: "LANCHA",
      launchNumber: 3,
    },
    regattaToken
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
      { competitionDateId: fx.competitionDateId, refereeId: fx.referee.userId, post: "LANCHA" },
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
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
