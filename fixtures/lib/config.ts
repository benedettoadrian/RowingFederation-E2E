export const DB_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://e2e:e2e@localhost:5433/rowing_e2e";
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
export const APP_URL = process.env.E2E_APP_URL ?? "http://localhost:5174";

/** Same password for every seeded fixture user — meets the backend's policy
 * (min 8, upper, lower, number) without needing per-role bookkeeping. */
export const FIXTURE_PASSWORD = "E2eTest123";

export const FIXTURE_CLUB_1_NAME = "Club E2E Uno";
export const FIXTURE_CLUB_2_NAME = "Club E2E Dos";
