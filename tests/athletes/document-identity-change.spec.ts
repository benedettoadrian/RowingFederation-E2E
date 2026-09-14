import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Data-integrity fix: editing an athlete's documentType or documentNumber
 * previously left every requirement document (identity scan, swimming
 * consent, athlete card) sitting at its old APPROVED status, even though it
 * was verified against the document that no longer applies. See
 * update-athlete.use-case.ts step 2 (confirmation gate) and step 6c
 * (reset + audit). This is the E2E counterpart to the Backend unit/
 * integration coverage — proves the full HTTP path, including the Zod
 * schema field that was found stripping confirmDocumentIdentityChange
 * during manual QA (not caught by any use-case-level unit test, since
 * those call execute() directly and bypass HTTP validation).
 */

async function createAthlete(token: string, clubId: string, documentNumber: string) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "DocChange",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "AR",
      documentType: "PASSPORT",
      documentNumber,
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
    athleteCard: { status: string };
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

/** Non-UY athlete: identity doc + swimming consent APPROVED is enough to
 * become eligible (no athlete card involved) and auto-activate to ACTIVE —
 * same helper pattern as status-transition-permissions.spec.ts. */
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

interface AuditLogsResponse {
  data: {
    auditLogs: Array<{
      action: string;
      entityType: string;
      entityId: string;
      changes: Record<string, any>;
    }>;
  };
}

test("changing documentNumber without confirmDocumentIdentityChange is rejected @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE");
  const documentNumber = `DC${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  // DocumentNumber is a paired value object (type+number together) — the
  // real edit form always submits both, so both are sent here too, only
  // documentNumber actually differs from the athlete's current value.
  await expect(
    api.put(
      `/athletes/${athleteId}`,
      { documentType: "PASSPORT", documentNumber: `DC${randomUUID().slice(0, 8)}` },
      token
    )
  ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
});

test("confirmed documentNumber change resets every requirement, drops an ACTIVE athlete to PENDING_APPROVAL, and audits both the athlete and each reset requirement @tier0", async () => {
  const { clubs, credentials } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE");
  const documentNumber = `DC${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  await makeFullyEligible(athleteId, token);
  const beforeChange = await api.get<{ data: { status: string } }>(
    `/athletes/${athleteId}`,
    token
  );
  expect(beforeChange.data.status).toBe("ACTIVE");

  // PASSPORT numbers are normalized to uppercase by DocumentNumber.create.
  const newDocumentNumber = `DC${randomUUID().slice(0, 8)}`.toUpperCase();
  const updated = await api.put<{ data: { status: string } }>(
    `/athletes/${athleteId}`,
    {
      documentType: "PASSPORT",
      documentNumber: newDocumentNumber,
      confirmDocumentIdentityChange: true,
    },
    token
  );
  expect(updated.data.status).toBe("PENDING_APPROVAL");

  const requirements = await api.get<RequirementsResponse>(
    `/athletes/${athleteId}/requirements`,
    token
  );
  expect(requirements.data.identityDoc.status).toBe("PENDING_UPLOAD");
  expect(requirements.data.swimmingConsent.status).toBe("PENDING_UPLOAD");
  expect(requirements.data.athleteCard.status).toBe("PENDING_UPLOAD");

  // Athlete's own audit entry records the delegate's confirmation.
  const athleteLogs = await api.get<AuditLogsResponse>(
    `/audit-logs/entity/Athlete/${athleteId}`,
    token
  );
  const updateLog = athleteLogs.data.auditLogs.find((l) => l.action === "UPDATE");
  expect(updateLog).toBeDefined();
  expect(updateLog?.changes.entityData?.delegateConfirmedDocumentReset).toBe(true);
  expect(updateLog?.changes.documentNumber?.new).toBe(newDocumentNumber);
  expect(updateLog?.changes.status?.new).toBe("PENDING_APPROVAL");

  // Each of the 3 reset requirements gets its own STATUS_CHANGE entry,
  // distinguishable from a real document-review outcome via `reason`.
  const requirementsResult = await api.get<{ data: { id: string } }>(
    `/athletes/${athleteId}/requirements`,
    token
  );
  const requirementsId = requirementsResult.data.id;
  const requirementsLogs = await api.get<AuditLogsResponse>(
    `/audit-logs/entity/AthleteRequirements/${requirementsId}`,
    token
  );
  const resetLogs = requirementsLogs.data.auditLogs.filter(
    (l) => l.changes.reason === "document-identity-changed"
  );
  expect(resetLogs).toHaveLength(3);
  const resetSlots = resetLogs.map((l) => l.changes.entityData?.documentType).sort();
  expect(resetSlots).toEqual(["athleteCard", "identityDoc", "swimmingConsent"]);
  expect(credentials.CLUB_DELEGATE).toBeDefined();
});

test("a documentType-only change (same documentNumber) also requires confirmation and resets requirements @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE");
  // Exactly 8 digits so the number stays valid under both PASSPORT
  // (6-12 alphanumeric) and NATIONAL_ID (exactly 8 digits) — the switch
  // below only changes documentType, so the number can't move.
  const documentNumber = `${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  await expect(
    api.put(
      `/athletes/${athleteId}`,
      { documentType: "NATIONAL_ID", documentNumber },
      token
    )
  ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);

  const updated = await api.put<{ data: { documentNumber: string } }>(
    `/athletes/${athleteId}`,
    { documentType: "NATIONAL_ID", documentNumber, confirmDocumentIdentityChange: true },
    token
  );
  expect(updated.data).toBeDefined();

  const requirements = await api.get<RequirementsResponse>(
    `/athletes/${athleteId}/requirements`,
    token
  );
  expect(requirements.data.identityDoc.status).toBe("PENDING_UPLOAD");
});
