import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Fase 4.4 — identity document upload triggers OCR (async, fire-and-forget:
 * POST returns 200 immediately with status PROCESSING; the real MATCHED/
 * REVIEW result lands later in the background). ocr-stub/server.ts mirrors
 * the real RowingFederation-OCR contract and branches purely on whether
 * documentNumber contains "OCRFAIL" — no real image content is inspected
 * anywhere in this path (backend fileFilter only checks mimetype/
 * extension), so a minimal 1x1 PNG is enough for both cases.
 */

interface RequirementsResponse {
  data: { identityDoc: { status: string } };
}

async function pollUntilNotProcessing(
  athleteId: string,
  token: string,
  maxWaitMs = 15_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await api.get<RequirementsResponse>(
      `/athletes/${athleteId}/requirements`,
      token
    );
    const status = res.data.identityDoc.status;
    if (status !== "PROCESSING" && status !== "PENDING_UPLOAD") {
      return status;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OCR processing did not settle within ${maxWaitMs}ms`);
}

function pngFormData(documentNumber: string, emissionDate: string): FormData {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  form.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  form.append("emissionDate", emissionDate);
  // Backend requires expirationDate for athletes under 60 (server-side
  // mirror of the Frontend's age-based requirement — see
  // upload-identity-doc.use-case.ts). createAthlete below always creates a
  // 2000-01-01 (under-60) athlete, so this must always be sent.
  form.append("expirationDate", "2033-01-01");
  return form;
}

async function createAthlete(token: string, clubId: string, documentNumber: string) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "OCR",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      // PASSPORT accepts alphanumeric (6-12 chars) — needed for the
      // "OCRFAIL" marker, which a numeric-only DNI format can't hold.
      documentType: "PASSPORT",
      documentNumber,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id;
}

test("identity doc upload resolves to APPROVED when OCR matches @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  const upload = await api.postMultipart<{ data: unknown; message: string }>(
    `/athletes/${athleteId}/requirements/identity-doc`,
    pngFormData(documentNumber, "2020-01-01"),
    token
  );
  expect(upload.message).toContain("background");

  const finalStatus = await pollUntilNotProcessing(athleteId, token);
  expect(finalStatus).toBe("APPROVED");
});

test("identity doc upload resolves to REVIEW when OCR can't match @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  // ocr-stub/server.ts forces REVIEW whenever documentNumber contains
  // "OCRFAIL" — PASSPORT format caps at 12 chars, so keep the suffix short.
  const documentNumber = `OCRFAIL${randomUUID().slice(0, 4)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  await api.postMultipart(
    `/athletes/${athleteId}/requirements/identity-doc`,
    pngFormData(documentNumber, "2020-01-01"),
    token
  );

  const finalStatus = await pollUntilNotProcessing(athleteId, token);
  expect(finalStatus).toBe("REVIEW");
});
