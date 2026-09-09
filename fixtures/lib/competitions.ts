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

  // Fresh entropy, independent of `suffix` — a 4-char slice of an 8-char
  // suffix collided under parallel test execution (birthday paradox at
  // 16^4 combinations across many concurrent club creations).
  const abbreviation = randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();
  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club Competitions ${suffix}`,
      abbreviation,
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

const ABBREVIATION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

async function createClub(adminToken: string, label: string) {
  // Fresh entropy per call, independent of `label` — abbreviation is only
  // 3-5 chars (regex ^[A-Z0-9]+$). A previous fix moved this off a
  // shared-suffix derivation (16^4 space, collided under parallel
  // execution) to a per-call randomUUID hex slice — but hex only draws
  // from 16 of the 36 chars the schema actually allows (0-9A-F vs
  // 0-9A-Z), leaving the 16^5 ≈ 1.05M space still collision-prone at
  // full-suite volume (~4% chance across a few hundred club creations,
  // birthday paradox). Drawing from the full A-Z0-9 alphabet instead
  // gets 36^5 ≈ 60.5M — the maximum entropy the 5-char cap allows.
  const abbreviation = Array.from(
    { length: 5 },
    () => ABBREVIATION_ALPHABET[Math.floor(Math.random() * ABBREVIATION_ALPHABET.length)]
  ).join("");
  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club Inscription ${label}`,
      abbreviation,
      addressCountry: "Uruguay",
      addressState: "Montevideo",
      addressCity: "Montevideo",
      addressStreet: "Rambla Sur 123",
      addressPostalCode: "11000",
      email: `club-inscription-${label}@e2e.test`,
      foundationDate: "1950-01-01",
      affiliationDate: "1950-01-01",
    },
    adminToken
  );
  return club.data.id;
}

/**
 * Full chain needed for a real crew-entry inscription: club(s) -> pista ->
 * boat -> age category -> event -> program (event attached) ->
 * competition-date (in INSCRIPTION_OPEN) -> a CLUB_DELEGATE + one eligible
 * athlete per club. Single-scull boat (1x, no coxswain) keeps crew size to
 * 1 athlete — CrewCompositionVO strictly validates ROWER count against
 * boat.athleteCount, and a 1-seat boat is the simplest valid composition to
 * build fixtures for.
 *
 * Athletes are created with status: "ACTIVE" directly (bypassing document
 * upload/approval — that flow is already covered by Fase 4.4) since
 * isEligibleForCompetition() requires ACTIVE status, and the default at
 * creation is PENDING_APPROVAL.
 */
export async function setupInscriptionFixtures(
  regattaToken: string,
  opts: {
    scoresInCircuit?: boolean;
    advanceToClosed?: boolean;
    dateOverrides?: Record<string, unknown>;
    // Master handicap tests need isMaster: true on the age category, plus
    // control over each club's athlete birthdate (the default "2000-01-01"
    // for both makes every crew the same age — useless for handicap math,
    // which only does anything interesting when ages differ).
    isMaster?: boolean;
    // Novicio-category fixture (see [[fur-novice-category-eligibility-plan]])
    // — mutually exclusive with isMaster in practice (no test needs both).
    isNovice?: boolean;
    club1AthleteBirthdate?: string;
    club2AthleteBirthdate?: string;
  } = {}
) {
  const suffix = randomUUID().slice(0, 8);
  const adminToken = await apiLoginAs("ADMIN");

  // Only needed to reach CLOSED (IN_REVIEW -> CLOSED requires
  // refereePresidentId already set, per competition-date-status.service.ts)
  // — created unconditionally is cheap and keeps this block simple.
  const refereeEmail = `referee-${suffix}@e2e.test`;
  const referee = await api.post<{ data: { id: string } }>(
    "/users",
    {
      email: refereeEmail,
      password: "E2eTest123",
      firstName: "Referee",
      lastName: suffix,
      birthDate: "1980-01-01",
      gender: "MALE",
      role: "REFEREE",
    },
    adminToken
  );

  const club1Id = await createClub(adminToken, `${suffix}A`);
  const club2Id = await createClub(adminToken, `${suffix}B`);

  const pista = await api.post<{ data: { id: string } }>(
    `/clubs/${club1Id}/pistas`,
    { name: `Pista ${suffix}`, waterBodyName: "Rio de la Plata", maxDistance: 2000, maxLanes: 6 },
    regattaToken
  );

  const program = await api.post<{ data: { id: string } }>(
    "/competitions/programs",
    { name: `Programa ${suffix}` },
    regattaToken
  );

  const boat = await api.post<{ data: { id: string } }>(
    "/competitions/boats",
    {
      // Boat.code feeds directly into the auto-generated Event.code
      // ({boatCode}-{category}-{gender}), which is globally unique — 3
      // chars of entropy collided under parallel test execution. Max
      // length is 10 (boat-validation.dto.ts), so use it all.
      code: `1X${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      name: "Single Scull",
      type: "SHELL",
      athleteCount: 1,
      hasCoxswain: false,
    },
    regattaToken
  );

  const ageCategory = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    {
      name: `${opts.isMaster ? "MASTER" : opts.isNovice ? "NOVICIOS" : "SENIOR"}-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      minAge: opts.isMaster ? 27 : opts.isNovice ? 0 : 19,
      maxAge: null,
      ...(opts.isMaster && { isMaster: true }),
      ...(opts.isNovice && { isNovice: true }),
    },
    regattaToken
  );

  // Event.code is auto-generated purely from {boatCode, category, gender}
  // (EventCodeVO) — it does NOT factor in name/distance/id at all. Two
  // events sharing boat+category+gender would generate the identical code
  // and the second POST would 400 as a duplicate. event2 needs its own
  // age category (reusing the same boat keeps crew composition simple:
  // athleteCount=1, no coxswain).
  const ageCategory2 = await api.post<{ data: { id: string } }>(
    "/competitions/age-categories",
    {
      name: `SENIOR-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      minAge: 19,
      maxAge: null,
    },
    regattaToken
  );

  const event = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `1x Senior Masculino ${suffix}`,
      boatId: boat.data.id,
      ageCategoryId: ageCategory.data.id,
      gender: "MALE",
      distance: 1000,
      hasHeats: false,
      ...(opts.scoresInCircuit && { scoresInCircuit: true }),
    },
    regattaToken
  );

  // Second event on the same program/date — lets a conflict test enter the
  // same athlete in two events on the same competition day without needing
  // to model exact heat times.
  const event2 = await api.post<{ data: { id: string } }>(
    "/competitions/events",
    {
      name: `1x Senior Masculino B ${suffix}`,
      boatId: boat.data.id,
      ageCategoryId: ageCategory2.data.id,
      gender: "MALE",
      distance: 2000,
      hasHeats: false,
      ...(opts.scoresInCircuit && { scoresInCircuit: true }),
    },
    regattaToken
  );

  await api.put(
    `/competitions/programs/${program.data.id}/events`,
    { eventIds: [event.data.id, event2.data.id] },
    regattaToken
  );

  // IN_REVIEW -> CLOSED also requires both crew-change-window fields set
  // (competition-date-status.service.ts, same gate as refereePresidentId) —
  // arbitrary but valid (opensAt < closesAt) is enough here, nothing in the
  // transition gate itself checks these against `date`/`startTime`.
  const crewChangeWindowOpensAt = new Date();
  crewChangeWindowOpensAt.setUTCDate(crewChangeWindowOpensAt.getUTCDate() - 1);
  const crewChangeWindowClosesAt = new Date();
  crewChangeWindowClosesAt.setUTCDate(crewChangeWindowClosesAt.getUTCDate() + 1);

  const dateFixtures = { clubId: club1Id, pistaId: pista.data.id, programId: program.data.id };
  const datePayload = competitionDatePayload(
    dateFixtures,
    // CompetitionDate.date is unique DB-wide. This fixture is now called
    // from ~20 tests across 5+ files (inscriptions, sorteo, results,
    // standings) — 5000 days of range collided under that volume
    // (birthday paradox). Widened by 100x. This also means the resulting
    // year can be centuries out — Master handicap tests need the real
    // value (see `date` in the return below) instead of assuming "now".
    30 + Math.floor(Math.random() * 500_000),
    {
      ...(opts.advanceToClosed && {
        refereePresidentId: referee.data.id,
        crewChangeWindowOpensAt: crewChangeWindowOpensAt.toISOString(),
        crewChangeWindowClosesAt: crewChangeWindowClosesAt.toISOString(),
      }),
      ...opts.dateOverrides,
    }
  );
  const created = await api.post<{ data: { id: string } }>(
    "/competitions/competition-dates",
    datePayload,
    regattaToken
  );
  const competitionDateId = created.data.id;

  await api.patch(`/competitions/competition-dates/${competitionDateId}/status`, { status: "PUBLISHED" }, regattaToken);
  await api.patch(
    `/competitions/competition-dates/${competitionDateId}/status`,
    { status: "INSCRIPTION_OPEN" },
    regattaToken
  );

  if (opts.advanceToClosed) {
    await api.patch(
      `/competitions/competition-dates/${competitionDateId}/status`,
      { status: "IN_REVIEW" },
      regattaToken
    );
    await api.patch(
      `/competitions/competition-dates/${competitionDateId}/status`,
      { status: "CLOSED" },
      regattaToken
    );
  }

  async function createDelegateAndAthlete(clubId: string, label: string, athleteBirthdate?: string) {
    const email = `delegate-${label}@e2e.test`;
    const delegateCreated = await api.post<{ data: { id: string } }>(
      "/users",
      {
        email,
        password: "E2eTest123",
        firstName: "Delegate",
        lastName: label,
        birthDate: "1990-01-01",
        gender: "MALE",
        role: "CLUB_DELEGATE",
        clubId,
      },
      adminToken
    );

    const athleteCreated = await api.post<{ data: { id: string } }>(
      "/athletes",
      {
        firstName: "Athlete",
        firstSurname: label,
        gender: "MALE",
        birthdate: athleteBirthdate ?? "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `INS${label}`,
        currentClubId: clubId,
        status: "ACTIVE",
      },
      adminToken
    );

    return {
      delegateUserId: delegateCreated.data.id,
      delegateEmail: email,
      delegatePassword: "E2eTest123",
      athleteId: athleteCreated.data.id,
    };
  }

  const club1Fixtures = await createDelegateAndAthlete(club1Id, `${suffix}A`, opts.club1AthleteBirthdate);
  const club2Fixtures = await createDelegateAndAthlete(club2Id, `${suffix}B`, opts.club2AthleteBirthdate);

  return {
    club1Id,
    club2Id,
    competitionDateId,
    // The real date used (see the widened-range comment above the payload
    // build) — Master handicap FISA-age math is relative to this date's
    // year, not "now", so tests can't hardcode an expected age from today's
    // date.
    date: datePayload.date,
    eventId: event.data.id,
    eventId2: event2.data.id,
    boatAthleteCount: 1,
    club1: club1Fixtures,
    club2: club2Fixtures,
    referee: {
      userId: referee.data.id,
      email: refereeEmail,
      password: "E2eTest123",
    },
  };
}
