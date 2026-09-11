import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Tier F (fur-minor-improvements-plan-2026-07) — the athlete card is
 * required for Uruguayan athletes (nationality === "UY") AND for anyone
 * holding a Uruguayan cédula de identidad (documentType === "NATIONAL_ID")
 * regardless of declared nationality — a foreign national with a valid
 * Uruguayan NATIONAL_ID is, by federation rule, required to be registered
 * with the Secretaría Nacional de Deporte. Everyone else only needs an
 * approved identity document + swimming consent to be eligible to compete.
 * Verified against AthleteRequirements.isAthleteCardRequirementMet() — a
 * non-UY, non-NATIONAL_ID athlete satisfies this leg unconditionally, an
 * athlete-card upload is never involved. The NATIONAL_ID gate was added
 * after a real production report (athlete Erick Claro Zapata, documentNumber
 * 66285109, nationality "CU" with a Uruguayan cédula, 2026-09-08) — the
 * "Ficha del atleta" section was silently hidden from the frontend because
 * only nationality was checked. ocr-stub/server.ts auto-approves identity
 * docs and swimming consent whenever the athlete's own documentNumber
 * doesn't contain "OCRFAIL" (mirrors document_validator.py/consent_validator.py
 * exactly).
 */

interface RequirementsResponse {
  data: {
    athleteCard: { isRequired: boolean; status: string };
    identityDoc: { status: string };
    swimmingConsent: { status: string };
    isEligibleToCompete: boolean;
  };
}

async function pollUntilSettled(
  athleteId: string,
  token: string,
  extract: (res: RequirementsResponse) => string,
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

async function createAthlete(
  token: string,
  clubId: string,
  nationality: string,
  documentNumber: string,
  documentType: string = "PASSPORT"
) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Elig",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality,
      documentType,
      documentNumber,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id as string;
}

// NATIONAL_ID (Uruguayan cédula) must be exactly 8 digits — unlike PASSPORT,
// letters aren't valid here.
function randomNationalId(): string {
  return String(Math.floor(10_000_000 + Math.random() * 89_999_999));
}

async function approveIdentityAndConsent(athleteId: string, token: string) {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");

  const identityForm = new FormData();
  identityForm.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  identityForm.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  identityForm.append("emissionDate", "2020-01-01");
  identityForm.append("expirationDate", "2033-01-01");
  await api.postMultipart(`/athletes/${athleteId}/requirements/identity-doc`, identityForm, token);
  const identityStatus = await pollUntilSettled(athleteId, token, (r) => r.data.identityDoc.status);
  expect(identityStatus).toBe("APPROVED");

  const consentForm = new FormData();
  consentForm.append("consent", new Blob([bytes], { type: "image/png" }), "consent.png");
  await api.postMultipart(`/athletes/${athleteId}/requirements/swimming-consent`, consentForm, token);
  const consentStatus = await pollUntilSettled(athleteId, token, (r) => r.data.swimmingConsent.status);
  expect(consentStatus).toBe("APPROVED");
}

test("athleteCard.isRequired is true for a Uruguayan athlete and false for a non-Uruguayan one @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");

  const uyAthleteId = await createAthlete(token, clubs.club1, "UY", `UY${randomUUID().slice(0, 8)}`);
  const arAthleteId = await createAthlete(token, clubs.club1, "AR", `AR${randomUUID().slice(0, 8)}`);

  const uyRes = await api.get<RequirementsResponse>(`/athletes/${uyAthleteId}/requirements`, token);
  const arRes = await api.get<RequirementsResponse>(`/athletes/${arAthleteId}/requirements`, token);

  expect(uyRes.data.athleteCard.isRequired).toBe(true);
  expect(arRes.data.athleteCard.isRequired).toBe(false);
});

test("a non-Uruguayan athlete becomes eligible to compete without ever touching the athlete card @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const athleteId = await createAthlete(token, clubs.club1, "PY", `PY${randomUUID().slice(0, 8)}`);

  await approveIdentityAndConsent(athleteId, token);

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.athleteCard.status).toBe("PENDING_UPLOAD"); // never touched
  expect(res.data.isEligibleToCompete).toBe(true);
});

test("a Uruguayan athlete stays ineligible without the athlete card, even with identity+consent approved @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const athleteId = await createAthlete(token, clubs.club1, "UY", `UYE${randomUUID().slice(0, 8)}`);

  await approveIdentityAndConsent(athleteId, token);

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.athleteCard.status).toBe("PENDING_UPLOAD");
  expect(res.data.isEligibleToCompete).toBe(false);
});

// Regression: real production case (Erick Claro Zapata, documentNumber
// 66285109, reported 2026-09-08). A foreign national holding a Uruguayan
// cédula de identidad must still be required to have a valid athlete card.
test("athleteCard.isRequired is true for a non-Uruguayan athlete holding a Uruguayan NATIONAL_ID (Erick Claro Zapata regression) @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");

  const athleteId = await createAthlete(
    token,
    clubs.club1,
    "CU",
    randomNationalId(),
    "NATIONAL_ID"
  );

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.athleteCard.isRequired).toBe(true);
});

test("a non-Uruguayan athlete holding a Uruguayan NATIONAL_ID stays ineligible without the athlete card, even with identity+consent approved @tier0", async () => {
  const { clubs } = loadFixtures();
  // FEDERATION_ADMIN, not ADMIN (see the same note in
  // document-upload.spec.ts): documentUploadRateLimiter is 20 req/15min
  // under NODE_ENV=production (which this E2E stack deliberately runs
  // with), keyed per-user — ADMIN is already reused across this same file
  // plus ocr-circuit-breaker.spec.ts and others, close enough to the
  // ceiling that this test's 2 uploads tripped a real 429 in practice.
  const token = await apiLoginAs("FEDERATION_ADMIN");
  const athleteId = await createAthlete(
    token,
    clubs.club1,
    "CU",
    randomNationalId(),
    "NATIONAL_ID"
  );

  await approveIdentityAndConsent(athleteId, token);

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.athleteCard.status).toBe("PENDING_UPLOAD");
  expect(res.data.isEligibleToCompete).toBe(false);
});
