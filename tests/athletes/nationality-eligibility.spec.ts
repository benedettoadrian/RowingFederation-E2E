import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Tier F (fur-minor-improvements-plan-2026-07) — the athlete card is only
 * required for Uruguayan athletes (nationality === "UY"); everyone else
 * only needs an approved identity document + swimming consent to be
 * eligible to compete. Verified against
 * AthleteRequirements.isAthleteCardRequirementMet() — a non-UY athlete
 * satisfies this leg unconditionally, an athlete-card upload is never
 * involved. ocr-stub/server.ts auto-approves identity docs and swimming
 * consent whenever the athlete's own documentNumber doesn't contain
 * "OCRFAIL" (mirrors document_validator.py/consent_validator.py exactly).
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

async function createAthlete(token: string, clubId: string, nationality: string, documentNumber: string) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Elig",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality,
      documentType: "PASSPORT",
      documentNumber,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id as string;
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
