import { randomUUID } from "node:crypto";
import { api } from "./api.js";
import { apiLoginAs } from "../auth.js";

/**
 * A fresh dev DB has zero clubs/pistas/programs (prisma/seeds/dev-seed.ts
 * wipes them) — competition-date creation needs an active pista belonging
 * to the organizing club, and an active program. Neither is pre-seeded, so
 * every competition test that needs a date builds this chain itself rather
 * than relying on club1/club2 from the main E2E seed (keeps this module's
 * fixtures isolated from the auth/IDOR fixtures other test files depend on).
 *
 * `regattaToken` is used for pista/program creation (requiresRegattaManager
 * — ADMIN/FEDERATION_ADMIN/REGATTA_COMMISSION all qualify). Club creation
 * needs its own ADMIN login internally: it's requiresFederationAdmin only
 * (ADMIN/FEDERATION_ADMIN), so a REGATTA_COMMISSION-only regattaToken would
 * 403 on that specific call — callers shouldn't have to know that split.
 */
export async function setupCompetitionDateFixtures(regattaToken: string) {
  const suffix = randomUUID().slice(0, 8);
  const adminToken = await apiLoginAs("ADMIN");

  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club Competitions ${suffix}`,
      abbreviation: suffix.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "9"),
      addressCountry: "Uruguay",
      addressState: "Montevideo",
      addressCity: "Montevideo",
      addressStreet: "Rambla Sur 123",
      addressPostalCode: "11000",
      email: `club-competitions-${suffix}@e2e.test`,
      foundationDate: "1950-01-01",
      affiliationDate: "1950-01-01",
    },
    adminToken
  );
  const clubId = club.data.id;

  const pista = await api.post<{ data: { id: string } }>(
    `/clubs/${clubId}/pistas`,
    {
      name: `Pista ${suffix}`,
      waterBodyName: "Rio de la Plata",
      maxDistance: 2000,
      maxLanes: 6,
    },
    regattaToken
  );

  const program = await api.post<{ data: { id: string } }>(
    "/competitions/programs",
    { name: `Programa ${suffix}` },
    regattaToken
  );

  return { clubId, pistaId: pista.data.id, programId: program.data.id };
}

/** Builds a valid competition-date payload N days in the future, so runs
 * never collide with each other's chosen date (CompetitionDate.date is
 * unique) regardless of when the suite runs. */
export function competitionDatePayload(
  fixtures: { clubId: string; pistaId: string; programId: string },
  daysFromNow: number,
  overrides: Record<string, unknown> = {}
) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(0, 0, 0, 0);
  const dateStr = date.toISOString();

  const openDate = new Date();
  openDate.setUTCDate(openDate.getUTCDate() + 1);

  // Must be strictly before the start of the competition day.
  const closeDate = new Date(date);
  closeDate.setUTCDate(closeDate.getUTCDate() - 1);
  closeDate.setUTCHours(23, 0, 0, 0);

  return {
    name: `Fecha E2E ${randomUUID().slice(0, 8)}`,
    organizingClubId: fixtures.clubId,
    pistaId: fixtures.pistaId,
    programId: fixtures.programId,
    date: dateStr,
    inscriptionOpenAt: openDate.toISOString(),
    inscriptionCloseAt: closeDate.toISOString(),
    startTime: "09:00",
    minutesBetweenHeats: 10,
    minutesBetweenFinals: 15,
    ...overrides,
  };
}
