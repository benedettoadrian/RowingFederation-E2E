import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * A CLUB_DELEGATE could set an athlete's status to anything the entity's
 * plain from→to state machine allowed — including forcing ACTIVE without
 * real documents, or SUSPENDED (a federation-level sanction). Corrected
 * rule (see update-athlete.use-case.ts):
 * - CLUB_DELEGATE: ACTIVE→INACTIVE always ok; →ACTIVE only if
 *   isEligibleToCompete; →SUSPENDED never.
 * - DIRECTORS/REGATTA_COMMISSION: newly admitted to PUT /athletes/:id, but
 *   status-only — any other field in the same payload is rejected.
 */

async function createAthlete(token: string, clubId: string, nationality = "AR") {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Status",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality,
      documentType: "PASSPORT",
      documentNumber: `ST${randomUUID().slice(0, 8)}`,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id as string;
}

interface RequirementsResponse {
  data: {
    identityDoc: { status: string };
    swimmingConsent: { status: string };
    isEligibleToCompete: boolean;
  };
}

async function pollUntilSettled(
  athleteId: string,
  token: string,
  extract: (r: RequirementsResponse) => string,
  maxWaitMs = 15_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
    const status = extract(res);
    if (status !== "PROCESSING" && status !== "PENDING_UPLOAD") return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Requirement did not settle within ${maxWaitMs}ms`);
}

/** Uploads identity doc + swimming consent and waits for both to settle — a
 * non-UY athlete becomes eligible as soon as these two are APPROVED (no
 * athlete card involved, see nationality-eligibility.spec.ts). */
async function makeFullyEligible(athleteId: string, token: string) {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");

  const identityForm = new FormData();
  identityForm.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  identityForm.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  identityForm.append("emissionDate", "2020-01-01");
  identityForm.append("expirationDate", "2033-01-01");
  await api.postMultipart(`/athletes/${athleteId}/requirements/identity-doc`, identityForm, token);
  await pollUntilSettled(athleteId, token, (r) => r.data.identityDoc.status);

  const consentForm = new FormData();
  consentForm.append("consent", new Blob([bytes], { type: "image/png" }), "consent.png");
  await api.postMultipart(`/athletes/${athleteId}/requirements/swimming-consent`, consentForm, token);
  await pollUntilSettled(athleteId, token, (r) => r.data.swimmingConsent.status);
}

test("a CLUB_DELEGATE cannot force-activate an athlete with incomplete documents @tier0", async () => {
  const { clubs } = loadFixtures();
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  const athleteId = await createAthlete(delegateToken, clubs.club1);

  await expect(
    api.put(`/athletes/${athleteId}`, { status: "ACTIVE" }, delegateToken)
  ).rejects.toMatchObject({
    status: 400,
    body: expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining("missing or expired") }),
    }),
  } satisfies Partial<ApiError>);
});

test("a CLUB_DELEGATE can reactivate INACTIVE → ACTIVE once documents are complete @tier0", async () => {
  const { clubs } = loadFixtures();
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  const athleteId = await createAthlete(delegateToken, clubs.club1);

  await makeFullyEligible(athleteId, delegateToken);
  // Auto-activation kicks in once documents settle — drive it back to
  // INACTIVE first so this test exercises the actual delegate-reactivation
  // path (the scenario reported: activo -> lo doy de baja -> lo reactivo).
  await api.put(`/athletes/${athleteId}`, { status: "INACTIVE" }, delegateToken);

  const reactivated = await api.put<{ data: { status: string } }>(
    `/athletes/${athleteId}`,
    { status: "ACTIVE" },
    delegateToken
  );
  expect(reactivated.data.status).toBe("ACTIVE");
});

test("a CLUB_DELEGATE can never set an athlete to SUSPENDED @tier0", async () => {
  const { clubs } = loadFixtures();
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  const athleteId = await createAthlete(delegateToken, clubs.club1);

  await expect(
    api.put(`/athletes/${athleteId}`, { status: "SUSPENDED" }, delegateToken)
  ).rejects.toMatchObject({
    status: 400,
    body: expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining("cannot suspend") }),
    }),
  } satisfies Partial<ApiError>);
});

test("PRESIDENT can suspend an athlete but only via a status-only payload @tier0", async () => {
  const { clubs } = loadFixtures();
  const adminToken = await apiLoginAs("ADMIN");
  const presidentToken = await apiLoginAs("PRESIDENT");
  const athleteId = await createAthlete(adminToken, clubs.club1);
  // SUSPENDED is only reachable from ACTIVE in the entity's state machine —
  // get there first (admin override, no eligibility check needed).
  await api.put(`/athletes/${athleteId}`, { status: "ACTIVE" }, adminToken);

  // Status-only payload succeeds — PRESIDENT was previously 403'd from this
  // route entirely (requiresClubDelegateOrAdmin only admitted CLUB_DELEGATE/
  // ADMIN/FEDERATION_ADMIN); the route now admits DIRECTORS too, scoped to
  // status-only in the controller.
  const suspended = await api.put<{ data: { status: string } }>(
    `/athletes/${athleteId}`,
    { status: "SUSPENDED" },
    presidentToken
  );
  expect(suspended.data.status).toBe("SUSPENDED");

  // Any other field in the same payload is rejected, even alongside status.
  await expect(
    api.put(`/athletes/${athleteId}`, { status: "ACTIVE", firstName: "Hacked" }, presidentToken)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("REGATTA_COMMISSION can suspend an athlete but cannot edit other athlete fields @tier0", async () => {
  const { clubs } = loadFixtures();
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const athleteId = await createAthlete(adminToken, clubs.club1);
  await api.put(`/athletes/${athleteId}`, { status: "ACTIVE" }, adminToken);

  const suspended = await api.put<{ data: { status: string } }>(
    `/athletes/${athleteId}`,
    { status: "SUSPENDED" },
    regattaToken
  );
  expect(suspended.data.status).toBe("SUSPENDED");

  await expect(
    api.put(`/athletes/${athleteId}`, { nationality: "BR" }, regattaToken)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});
