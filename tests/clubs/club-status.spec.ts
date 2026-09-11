import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, createUserAndResetPassword } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 8.2 — club status transitions. Enum is ACTIVE/DEBTOR/PENALIZED/
 * INACTIVE (not the Spanish DEUDOR/PENALIZADO from the task wording).
 * Transition rules (Club.changeStatus()): ACTIVE -> {DEBTOR,PENALIZED,
 * INACTIVE}, DEBTOR -> {ACTIVE,PENALIZED}, PENALIZED -> {ACTIVE,INACTIVE},
 * INACTIVE -> {ACTIVE}.
 *
 * KNOWN GAP found while writing this: the club response DTO's
 * canRegisterAthletes field (isInGoodStanding() || status===DEBTOR) claims
 * a DEBTOR club can still register athletes — but the actual enforcement
 * in create-athlete.use-case.ts / create-crew-entry.use-case.ts hardcodes
 * a check for status===ACTIVE specifically, for CLUB_DELEGATE requesters.
 * A DEBTOR club's own delegate is blocked from both athlete creation and
 * inscription creation despite the DTO field saying otherwise. Documented
 * per the user's 2026-07-10 decision, not fixed in this pass.
 */

async function createClubWithDelegate(adminToken: string) {
  const suffix = randomUUID().slice(0, 8);
  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club Status ${suffix}`,
      abbreviation: randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase(),
      addressCountry: "Uruguay",
      addressState: "Montevideo",
      addressCity: "Montevideo",
      addressStreet: "Rambla Sur 123",
      addressPostalCode: "11000",
      email: `club-status-${suffix}@e2e.test`,
      foundationDate: "1950-01-01",
      affiliationDate: "1950-01-01",
    },
    adminToken
  );
  const clubId = club.data.id;

  const email = `delegate-status-${suffix}@e2e.test`;
  const delegate = await createUserAndResetPassword(
    adminToken,
    {
      email,
      firstName: "Status",
      lastName: suffix,
      birthDate: "1990-01-01",
      gender: "MALE",
      role: "CLUB_DELEGATE",
      clubId,
    },
    "E2eTest123"
  );
  const login = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password: delegate.password,
  });

  return { clubId, delegateToken: login.data.accessToken };
}

test("golden path: ACTIVE -> DEBTOR -> ACTIVE is allowed @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubId } = await createClubWithDelegate(adminToken);

  await api.patch(`/clubs/${clubId}/status`, { status: "DEBTOR" }, adminToken);
  let club = await api.get<{ data: { status: string } }>(`/clubs/${clubId}`, adminToken);
  expect(club.data.status).toBe("DEBTOR");

  await api.patch(`/clubs/${clubId}/status`, { status: "ACTIVE" }, adminToken);
  club = await api.get<{ data: { status: string } }>(`/clubs/${clubId}`, adminToken);
  expect(club.data.status).toBe("ACTIVE");
});

test("rejects an invalid transition: INACTIVE -> DEBTOR @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubId } = await createClubWithDelegate(adminToken);

  await api.patch(`/clubs/${clubId}/status`, { status: "INACTIVE" }, adminToken);

  await expect(
    api.patch(`/clubs/${clubId}/status`, { status: "DEBTOR" }, adminToken)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("KNOWN GAP: canRegisterAthletes says true for DEBTOR, but a DEBTOR club's delegate is actually blocked from creating an athlete @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubId, delegateToken } = await createClubWithDelegate(adminToken);

  await api.patch(`/clubs/${clubId}/status`, { status: "DEBTOR" }, adminToken);

  const club = await api.get<{ data: { canRegisterAthletes: boolean } }>(
    `/clubs/${clubId}`,
    adminToken
  );
  expect(club.data.canRegisterAthletes).toBe(true);

  await expect(
    api.post(
      "/athletes",
      {
        firstName: "Blocked",
        firstSurname: randomUUID().slice(0, 8),
        gender: "MALE",
        birthdate: "2000-01-01",
        nationality: "UY",
        documentType: "PASSPORT",
        documentNumber: `DEBT${randomUUID().slice(0, 6)}`,
        currentClubId: clubId,
      },
      delegateToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
