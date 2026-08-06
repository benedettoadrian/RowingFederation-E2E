import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Dashboards por rol — endpoints de agregación nuevos (backend puro, sin UI):
 * resumen de fechas, resumen post-competencia, historial de árbitro,
 * atletas sin documentos, ranking de clubes por actividad, atletas por
 * cambiar de categoría, resumen ejecutivo. Ver [[fur-role-dashboards-plan]].
 */

// ── Resumen de fechas de competencia (Comisión de Regatas / Admin) ─────────

test("dashboard-summary: returns counts by status and flags a date missing referee president @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);

  const summary = await api.get<{
    data: {
      countsByStatus: Record<string, number>;
      dates: {
        id: string;
        missingRefereePresident: boolean;
        missingCrewChangeWindow: boolean;
        sorteoPending: boolean | null;
      }[];
    };
  }>("/competitions/competition-dates/dashboard-summary", regattaToken);

  expect(summary.data.countsByStatus.INSCRIPTION_OPEN).toBeGreaterThan(0);
  const ourDate = summary.data.dates.find((d) => d.id === fx.competitionDateId);
  expect(ourDate).toBeTruthy();
  expect(ourDate!.missingRefereePresident).toBe(true);
  expect(ourDate!.missingCrewChangeWindow).toBe(true);
  expect(ourDate!.sorteoPending).toBeNull(); // only computed for IN_REVIEW
});

test("dashboard-summary: rejects a CLUB_DELEGATE (regatta-manager only) @tier0", async () => {
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  await expect(
    api.get("/competitions/competition-dates/dashboard-summary", delegateToken)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

// ── Resumen post-competencia (Comisión de Regatas) ─────────────────────────

test("post-competition-summary: returns zeros for a date with no exclusions @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);

  const summary = await api.get<{
    data: {
      totalBoats: number;
      excludedByLaneControl: number;
      excludedByCard: number;
      dns: number;
      dnsJustified: number;
      abandoned: number;
    };
  }>(`/competitions/competition-dates/${fx.competitionDateId}/post-competition-summary`, regattaToken);

  expect(summary.data).toEqual({
    totalBoats: 0,
    excludedByLaneControl: 0,
    excludedByCard: 0,
    dns: 0,
    dnsJustified: 0,
    abandoned: 0,
  });
});

// ── Historial de árbitro (self-scoped) ──────────────────────────────────────

test("referee my-history: shows a post the referee was just assigned, most recent first @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const refereeToken = await apiLoginAs("REFEREE");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  await api.post(
    "/competitions/referee-work-assignments",
    {
      competitionDateId: fx.competitionDateId,
      refereeId: credentials.REFEREE.userId,
      post: "CONTROL_PISTA",
      scheduledFrom: "08:00",
      scheduledTo: "20:00",
    },
    refereeToken
  );

  const history = await api.get<{
    data: { competitionDateId: string; post: string }[];
  }>("/competitions/referee-work-assignments/my-history", refereeToken);

  const entry = history.data.find((h) => h.competitionDateId === fx.competitionDateId);
  expect(entry).toBeTruthy();
  expect(entry!.post).toBe("CONTROL_PISTA");
});

// ── Atletas sin ningún documento (Super-admin) ──────────────────────────────

test("athletes without-documents: a freshly created athlete (no uploads) appears in the list @tier0", async () => {
  const { clubs } = loadFixtures();
  const adminToken = await apiLoginAs("ADMIN");

  const athlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "SinDocs",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `NODOC${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      currentClubId: clubs.club1,
    },
    adminToken
  );

  // High explicit limit — this endpoint's default (50) is meant for a small
  // "attention" widget, not a complete list, and the full E2E run creates
  // far more than 50 doc-less athletes across other files/parallel workers.
  const result = await api.get<{ data: { athleteId: string }[] }>(
    "/athletes/without-documents?limit=5000",
    adminToken
  );
  expect(result.data.some((a) => a.athleteId === athlete.data.id)).toBe(true);
});

test("athletes without-documents: rejects a CLUB_DELEGATE (federation-wide, admin only) @tier0", async () => {
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  await expect(api.get("/athletes/without-documents", delegateToken)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

// ── Atletas por cambiar de categoría (Delegado de Club) ─────────────────────

// The "does this athlete actually cross a boundary" logic is unit-tested
// with full control over age-category data (3 isolated tests, see
// get-athletes-nearing-category-change.use-case.spec.ts). Age categories
// are global, shared, cumulative state across this whole E2E run (every
// spec file that calls setupInscriptionFixtures adds its own Senior/Master
// category) — a fresh category created here has no way to guarantee it
// "wins" over an existing wider one when many run in parallel. E2E's job
// is narrower: prove the endpoint is wired, scoped, and reachable.
test("athletes nearing-category-change: reachable and scoped to the given club @tier0" , async () => {
  const { clubs, athletes } = loadFixtures();
  const adminToken = await apiLoginAs("ADMIN");

  const result = await api.get<{
    data: { athleteId: string; clubId: string }[];
  }>(`/athletes/nearing-category-change?clubId=${clubs.club1}`, adminToken);

  expect(Array.isArray(result.data)).toBe(true);
  expect(result.data.every((a) => a.clubId === clubs.club1)).toBe(true);
  // Doesn't leak club2's athlete into a club1-scoped query.
  expect(result.data.some((a) => a.athleteId === athletes.club2)).toBe(false);
});

test("athletes nearing-category-change: requires a clubId @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  await expect(
    api.get("/athletes/nearing-category-change", adminToken)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

// ── Ranking de clubes por actividad (Super-admin) ───────────────────────────

test("clubs activity-ranking: returns clubs ordered by active athlete count, descending @tier0" , async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const result = await api.get<{
    data: { clubId: string; activeAthleteCount: number }[];
  }>("/clubs/activity-ranking", adminToken);

  expect(Array.isArray(result.data)).toBe(true);
  for (let i = 1; i < result.data.length; i++) {
    expect(result.data[i - 1]!.activeAthleteCount).toBeGreaterThanOrEqual(
      result.data[i]!.activeAthleteCount
    );
  }
});

test("clubs activity-ranking: rejects a CLUB_DELEGATE @tier0", async () => {
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  await expect(api.get("/clubs/activity-ranking", delegateToken)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

// ── Resumen ejecutivo del mes (Directorio) ──────────────────────────────────

test("dashboard executive-summary: accessible to a Directorio role (PRESIDENT) @tier0", async () => {
  const presidentToken = await apiLoginAs("PRESIDENT");
  const result = await api.get<{
    data: { monthLabel: string; newUsers: number; newClubs: number };
  }>("/dashboard/executive-summary", presidentToken);

  expect(typeof result.data.monthLabel).toBe("string");
  expect(result.data.monthLabel.length).toBeGreaterThan(0);
  expect(typeof result.data.newUsers).toBe("number");
});

test("dashboard executive-summary: rejects a REFEREE (not Directorio/admin) @tier0", async () => {
  const refereeToken = await apiLoginAs("REFEREE");
  await expect(api.get("/dashboard/executive-summary", refereeToken)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});
