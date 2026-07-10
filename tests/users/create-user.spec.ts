import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { FIXTURE_PASSWORD } from "../../fixtures/lib/config.js";

/**
 * Fase 4.1/4.2 — user creation golden paths + the 4 business rules gating
 * POST /users (RoleValidationService, role-validation.service.ts). All 4
 * surface as a plain 400 BAD_REQUEST with a human-readable message — no
 * dedicated error code per rule, verified against the actual source before
 * writing these assertions.
 *
 * Director-role (PRESIDENT/VICE_PRESIDENT/...) and ADMIN/FEDERATION_ADMIN
 * golden-path creation is NOT re-tested here in isolation: fixtures/seed.ts
 * already creates one of every one of the 11 roles through this same real
 * endpoint, and the whole suite depends on that succeeding — a regression
 * there fails every test, not silently. This file focuses on the 4
 * business-rule boundaries, which seeding alone doesn't exercise, plus a
 * golden-path check for the two roles with no seed-state conflicts
 * (REGATTA_COMMISSION, REFEREE) and CLUB_DELEGATE under its 2-per-club cap.
 */

function userPayload(role: string, extra: Record<string, unknown> = {}) {
  return {
    email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@e2e.test`,
    password: FIXTURE_PASSWORD,
    firstName: "Fixture",
    lastName: role,
    birthDate: "1990-01-01",
    gender: "MALE",
    role,
    ...extra,
  };
}

// R-ROLE-001/002 mutate a GLOBAL count (total active ADMIN / FEDERATION_ADMIN
// users, not scoped to a club) — serial so no other parallel test's user
// creation perturbs the count these assertions depend on.
test.describe.serial("R-ROLE-001: max 3 ADMIN", () => {
  test("allows the 2nd and 3rd ADMIN, rejects the 4th @tier0", async () => {
    const token = await apiLoginAs("ADMIN");

    // Seed already created 1 (bootstrap) — these 2 bring the total to 3.
    await api.post("/users", userPayload("ADMIN"), token);
    await api.post("/users", userPayload("ADMIN"), token);

    await expect(api.post("/users", userPayload("ADMIN"), token)).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<ApiError>);
  });
});

test.describe.serial("R-ROLE-002: max 3 FEDERATION_ADMIN", () => {
  test("allows the 2nd and 3rd FEDERATION_ADMIN, rejects the 4th @tier0", async () => {
    const token = await apiLoginAs("ADMIN");

    // Seed already created 1 fixture — these 2 bring the total to 3.
    await api.post("/users", userPayload("FEDERATION_ADMIN"), token);
    await api.post("/users", userPayload("FEDERATION_ADMIN"), token);

    await expect(
      api.post("/users", userPayload("FEDERATION_ADMIN"), token)
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
  });
});

test("R-ROLE-003: rejects a 2nd active PRESIDENT with an overlapping term @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  // Seed's PRESIDENT fixture has directorStartDate 2020-01-01 with no
  // directorEndDate (open-ended) — any new PRESIDENT necessarily overlaps
  // it, which is the more common real-world mistake (double-booking a
  // still-active role) than the gap case. The gap-specific branch needs a
  // predecessor with a real end date; none of the 6 seeded director roles
  // have one (all open-ended), and setting one would mutate shared fixture
  // state other tests may depend on being "currently active" — not done
  // here, noted for whoever adds a dedicated director-transition test.
  await expect(
    api.post(
      "/users",
      userPayload("PRESIDENT", { directorType: "PRESIDENT", directorStartDate: "2025-01-01" }),
      token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("R-ROLE-004: allows 2 CLUB_DELEGATE per club, rejects the 3rd @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  // Fresh, isolated club — not club1/club2 from seed, which already carry
  // fixture delegates other tests rely on staying put. Avoids any race with
  // parallel tests touching the shared clubs.
  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club R-ROLE-004 ${randomUUID().slice(0, 8)}`,
      abbreviation: randomUUID().slice(0, 3).toUpperCase(),
      addressCountry: "Uruguay",
      addressState: "Montevideo",
      addressCity: "Montevideo",
      addressStreet: "Rambla Sur 123",
      addressPostalCode: "11000",
      email: `club-${randomUUID().slice(0, 8)}@e2e.test`,
      foundationDate: "1950-01-01",
      affiliationDate: "1950-01-01",
    },
    token
  );
  const clubId = club.data.id;

  await api.post("/users", userPayload("CLUB_DELEGATE", { clubId }), token);
  await api.post("/users", userPayload("CLUB_DELEGATE", { clubId }), token);

  await expect(
    api.post("/users", userPayload("CLUB_DELEGATE", { clubId }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

for (const role of ["REGATTA_COMMISSION", "REFEREE"]) {
  test(`golden path: creates a ${role} user @tier0`, async () => {
    const token = await apiLoginAs("ADMIN");
    const created = await api.post<{ data: { id: string; roles: string[] } }>(
      "/users",
      userPayload(role),
      token
    );
    expect(created.data.roles).toContain(role);
  });
}
