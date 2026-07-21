/**
 * E2E fixture seed.
 *
 * Only the very first ADMIN is created by writing straight to Postgres
 * (bootstrap-admin.ts) — there is no other way to get a first authenticated
 * user. Every other fixture (both remaining clubs and all 10 remaining
 * role-users) is created through the REAL backend HTTP API, authenticated
 * as that bootstrap admin, so the seed itself already exercises the same
 * creation endpoints the E2E tests will assert against — not a shortcut
 * around them.
 *
 * Run with `npm run seed` after `npm run stack:up` (waits for backend
 * health itself, but the stack still needs to be up).
 */
import { writeFile } from "node:fs/promises";
import { bootstrapAdmin, BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { api, waitForHealth } from "./lib/api.js";
import { FIXTURE_PASSWORD, FIXTURE_CLUB_1_NAME, FIXTURE_CLUB_2_NAME } from "./lib/config.js";

interface AuthResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    user: { id: string; roles: string[] };
  };
}

interface CreatedUser {
  data: { id: string };
}

interface CreatedClub {
  data: { id: string };
}

type RoleKey =
  | "ADMIN"
  | "FEDERATION_ADMIN"
  | "PRESIDENT"
  | "VICE_PRESIDENT"
  | "GENERAL_SECRETARY"
  | "TREASURER"
  | "MINUTES_SECRETARY"
  | "REGATTA_COMMISSION"
  | "REFEREE"
  | "CLUB_DELEGATE"
  | "CLUB_DELEGATE_2"
  | "DELEGATE"
  | "COMMUNICATIONS";

/** RoleKey -> real backend UserRole sent in the create-user payload. Only
 * differs for CLUB_DELEGATE_2, which is a second fixture identity for the
 * same real CLUB_DELEGATE role, scoped to club2 instead of club1 — needed
 * for cross-club IDOR tests (a single CLUB_DELEGATE fixture can't prove
 * anything about cross-club isolation on its own). */
const BACKEND_ROLE: Partial<Record<RoleKey, string>> = {
  CLUB_DELEGATE_2: "CLUB_DELEGATE",
};

const DIRECTOR_ROLES: RoleKey[] = [
  "PRESIDENT",
  "VICE_PRESIDENT",
  "GENERAL_SECRETARY",
  "TREASURER",
  "MINUTES_SECRETARY",
  "DELEGATE",
];

const credentials: Record<RoleKey, { email: string; password: string; userId?: string }> = {
  ADMIN: { email: BOOTSTRAP_ADMIN_EMAIL, password: FIXTURE_PASSWORD },
  FEDERATION_ADMIN: { email: "federation-admin@e2e.test", password: FIXTURE_PASSWORD },
  PRESIDENT: { email: "president@e2e.test", password: FIXTURE_PASSWORD },
  VICE_PRESIDENT: { email: "vice-president@e2e.test", password: FIXTURE_PASSWORD },
  GENERAL_SECRETARY: { email: "general-secretary@e2e.test", password: FIXTURE_PASSWORD },
  TREASURER: { email: "treasurer@e2e.test", password: FIXTURE_PASSWORD },
  MINUTES_SECRETARY: { email: "minutes-secretary@e2e.test", password: FIXTURE_PASSWORD },
  REGATTA_COMMISSION: { email: "regatta-commission@e2e.test", password: FIXTURE_PASSWORD },
  REFEREE: { email: "referee@e2e.test", password: FIXTURE_PASSWORD },
  CLUB_DELEGATE: { email: "club-delegate-1@e2e.test", password: FIXTURE_PASSWORD },
  CLUB_DELEGATE_2: { email: "club-delegate-2@e2e.test", password: FIXTURE_PASSWORD },
  DELEGATE: { email: "delegate@e2e.test", password: FIXTURE_PASSWORD },
  COMMUNICATIONS: { email: "communications@e2e.test", password: FIXTURE_PASSWORD },
};

async function main() {
  console.log("Waiting for backend health...");
  await waitForHealth();

  console.log("Bootstrapping ADMIN directly in Postgres...");
  await bootstrapAdmin();

  console.log("Logging in as bootstrap ADMIN...");
  const login = await api.post<AuthResponse>("/auth/login", {
    email: BOOTSTRAP_ADMIN_EMAIL,
    password: FIXTURE_PASSWORD,
  });
  const adminToken = login.data.accessToken;
  credentials.ADMIN.userId = login.data.user.id;

  console.log("Creating 2 fixture clubs...");
  const club1 = await api.post<CreatedClub>(
    "/clubs",
    clubPayload(FIXTURE_CLUB_1_NAME, "CE1"),
    adminToken
  );
  const club2 = await api.post<CreatedClub>(
    "/clubs",
    clubPayload(FIXTURE_CLUB_2_NAME, "CE2"),
    adminToken
  );
  console.log(`  club1=${club1.data.id} club2=${club2.data.id}`);

  console.log("Creating 12 remaining role fixture users...");
  for (const role of Object.keys(credentials) as RoleKey[]) {
    if (role === "ADMIN") continue; // already the bootstrap admin

    const fixture = credentials[role];
    const [localPart] = fixture.email.split("@");
    const isDirector = DIRECTOR_ROLES.includes(role);

    const payload: Record<string, unknown> = {
      email: fixture.email,
      password: fixture.password,
      firstName: "E2E",
      lastName: localPart.replace(/-/g, " "),
      birthDate: "1990-01-01",
      gender: "MALE",
      role: BACKEND_ROLE[role] ?? role,
    };

    if (isDirector) {
      payload.directorType = role;
      payload.directorStartDate = "2020-01-01";
    }
    if (role === "CLUB_DELEGATE") {
      payload.clubId = club1.data.id;
    }
    if (role === "CLUB_DELEGATE_2") {
      payload.clubId = club2.data.id;
    }

    const created = await api.post<CreatedUser>("/users", payload, adminToken);
    fixture.userId = created.data.id;
    console.log(`  ${role} -> ${fixture.email} (${created.data.id})`);
  }

  console.log("Creating 1 fixture athlete per club (for cross-club IDOR tests)...");
  const athlete1 = await api.post<CreatedUser>(
    "/athletes",
    athletePayload("ClubUno", "40111222", club1.data.id),
    adminToken
  );
  const athlete2 = await api.post<CreatedUser>(
    "/athletes",
    athletePayload("ClubDos", "40111333", club2.data.id),
    adminToken
  );
  console.log(`  athlete(club1)=${athlete1.data.id} athlete(club2)=${athlete2.data.id}`);

  await writeFile(
    new URL("./credentials.json", import.meta.url),
    JSON.stringify(
      {
        credentials,
        clubs: { club1: club1.data.id, club2: club2.data.id },
        athletes: { club1: athlete1.data.id, club2: athlete2.data.id },
      },
      null,
      2
    )
  );

  console.log("\nSeed complete. Wrote fixtures/credentials.json");
}

function athletePayload(surnameSuffix: string, documentNumber: string, clubId: string) {
  return {
    firstName: "Atleta",
    firstSurname: surnameSuffix,
    gender: "MALE",
    birthdate: "2000-01-01",
    nationality: "Uruguay",
    documentType: "DNI",
    documentNumber,
    currentClubId: clubId,
  };
}

function clubPayload(name: string, abbreviation: string) {
  return {
    name,
    abbreviation,
    addressCountry: "Uruguay",
    addressState: "Montevideo",
    addressCity: "Montevideo",
    addressStreet: "Rambla Sur 123",
    addressPostalCode: "11000",
    email: `${abbreviation.toLowerCase()}@e2e.test`,
    foundationDate: "1950-01-01",
    affiliationDate: "1950-01-01",
  };
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
