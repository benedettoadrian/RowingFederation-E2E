import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * T02/OCR-2 — guardian identity document, required only for minor athletes.
 * Mirrors document-upload.spec.ts's identity-doc OCR-outcome tests (same
 * ocr-stub, same "documentNumber contains OCRFAIL" deterministic marker —
 * `/extract-document` is a single generic endpoint shared by both the
 * athlete's own identity doc and the guardian's, branching only on the
 * `documentNumber` field in the request body, regardless of which Backend
 * use-case called it).
 */

interface RequirementsResponse {
  data: {
    guardianDoc: { isRequired: boolean; status: string; reviewNote: string | null };
    isEligibleToCompete: boolean;
  };
}

async function pollUntilGuardianNotProcessing(
  athleteId: string,
  token: string,
  maxWaitMs = 15_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
    const status = res.data.guardianDoc.status;
    if (status !== "PROCESSING") return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Guardian doc OCR processing did not settle within ${maxWaitMs}ms`);
}

function guardianFormData(documentNumber: string): FormData {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  form.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  form.append("emissionDate", "2020-01-01");
  form.append("expirationDate", "2033-01-01");
  form.append("guardianFirstName", "Ana");
  form.append("guardianLastName", "Pérez");
  form.append("guardianDocumentType", "NATIONAL_ID");
  form.append("guardianDocumentNumber", documentNumber);
  form.append("guardianBirthdate", "1985-05-15");
  form.append("guardianRelationship", "Madre");
  return form;
}

async function createAthlete(
  token: string,
  clubId: string,
  documentNumber: string,
  birthdate: string
) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Guardian",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate,
      nationality: "Uruguay",
      documentType: "PASSPORT",
      documentNumber,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id;
}

test("a minor athlete's requirements mark the guardian document as required @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "2015-01-01");

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);

  expect(res.data.guardianDoc.isRequired).toBe(true);
  expect(res.data.guardianDoc.status).toBe("PENDING_UPLOAD");
  expect(res.data.isEligibleToCompete).toBe(false);
});

test("an adult athlete's requirements do NOT require a guardian document @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `A${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "1990-01-01");

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);

  expect(res.data.guardianDoc.isRequired).toBe(false);
});

test("uploading a guardian document for an adult athlete is rejected @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `A${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "1990-01-01");

  await expect(
    api.postMultipart(
      `/athletes/${athleteId}/requirements/guardian-identity-doc`,
      guardianFormData(`G${randomUUID().slice(0, 8)}`),
      token
    )
  ).rejects.toThrow(/400/);
});

test("guardian doc upload resolves to APPROVED when OCR matches, unblocking eligibility (given the other 3 requirements) @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "2015-01-01");

  const upload = await api.postMultipart<{ message: string }>(
    `/athletes/${athleteId}/requirements/guardian-identity-doc`,
    guardianFormData(`G${randomUUID().slice(0, 8)}`),
    token
  );
  expect(upload.message).toContain("background");

  const finalStatus = await pollUntilGuardianNotProcessing(athleteId, token);
  expect(finalStatus).toBe("APPROVED");

  // Still not eligible overall — identity doc/consent/card weren't uploaded
  // in this test, only proving the guardian leg itself resolved correctly.
  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.isEligibleToCompete).toBe(false);
});

test("guardian doc upload resolves to REVIEW when OCR can't match @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "2015-01-01");

  await api.postMultipart(
    `/athletes/${athleteId}/requirements/guardian-identity-doc`,
    guardianFormData(`OCRFAIL${randomUUID().slice(0, 4)}`),
    token
  );

  const finalStatus = await pollUntilGuardianNotProcessing(athleteId, token);
  expect(finalStatus).toBe("REVIEW");

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.guardianDoc.reviewNote).toBeTruthy();
});

test("a reviewer can approve a guardian document stuck in REVIEW @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber, "2015-01-01");

  await api.postMultipart(
    `/athletes/${athleteId}/requirements/guardian-identity-doc`,
    guardianFormData(`OCRFAIL${randomUUID().slice(0, 4)}`),
    token
  );
  await pollUntilGuardianNotProcessing(athleteId, token);

  await api.put(
    `/athletes/${athleteId}/requirements/guardian-identity-doc/review`,
    { action: "approve" },
    token
  );

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.guardianDoc.status).toBe("APPROVED");
});
