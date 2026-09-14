import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Fase 4.4 — identity document upload triggers OCR (async, fire-and-forget:
 * POST returns 200 immediately with status PROCESSING; the real MATCHED/
 * REVIEW result lands later in the background). ocr-stub/server.ts mirrors
 * the real RowingFederation-OCR contract and branches purely on whether
 * documentNumber contains "OCRFAIL" — no real image content is inspected
 * for the OCR-match outcome (backend fileFilter only checks mimetype/
 * extension), so a minimal 1x1 PNG is enough for both cases. The
 * image-quality pre-check (upload-identity-doc.use-case.ts, calling
 * POST /validate-image before anything is saved) is a separate,
 * synchronous, blocking step — the stub branches that one on the uploaded
 * filename containing "BADIMG" instead, since it runs before OCR entirely.
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

function pngFormData(
  documentNumber: string,
  emissionDate: string,
  filenames: { front: string; back: string } = { front: "front.png", back: "back.png" }
): FormData {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("front", new Blob([bytes], { type: "image/png" }), filenames.front);
  form.append("back", new Blob([bytes], { type: "image/png" }), filenames.back);
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

test("identity doc upload is rejected outright when the front photo fails the image-quality check, before OCR ever runs @tier0", async () => {
  const { clubs } = loadFixtures();
  // FEDERATION_ADMIN (not ADMIN, unlike the two tests above): the
  // documentUploadRateLimiter (20 req/15min under NODE_ENV=production,
  // which this E2E stack deliberately runs with) is keyed per-user — ADMIN
  // is already reused across ocr-circuit-breaker.spec.ts (7 calls),
  // nationality-eligibility.spec.ts and others, close enough to the ceiling
  // that adding these 2 tests under ADMIN tripped a real 429 in practice.
  const token = await apiLoginAs("FEDERATION_ADMIN");
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  const rejection: unknown = await api
    .postMultipart(
      `/athletes/${athleteId}/requirements/identity-doc`,
      pngFormData(documentNumber, "2020-01-01", { front: "BADIMG-front.png", back: "back.png" }),
      token
    )
    .catch((e) => e);

  expect(rejection).toBeInstanceOf(ApiError);
  const error = rejection as ApiError;
  expect(error.status).toBe(400);
  const body = error.body as { error?: { details?: { reason?: string; side?: string } } };
  expect(body.error?.details?.reason).toBe("IMAGE_QUALITY_REJECTED");
  expect(body.error?.details?.side).toBe("front");

  // Rejected at the pre-check — nothing was ever saved, so the record stays
  // at its pristine PENDING_UPLOAD state instead of PROCESSING/REVIEW.
  const requirements = await api.get<RequirementsResponse>(
    `/athletes/${athleteId}/requirements`,
    token
  );
  expect(requirements.data.identityDoc.status).toBe("PENDING_UPLOAD");
});

test("identity doc upload is rejected when the back photo fails the image-quality check @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("FEDERATION_ADMIN"); // see comment on the test above
  const documentNumber = `M${randomUUID().slice(0, 8)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  const rejection: unknown = await api
    .postMultipart(
      `/athletes/${athleteId}/requirements/identity-doc`,
      pngFormData(documentNumber, "2020-01-01", { front: "front.png", back: "BADIMG-back.png" }),
      token
    )
    .catch((e) => e);

  expect(rejection).toBeInstanceOf(ApiError);
  const body = (rejection as ApiError).body as { error?: { details?: { side?: string } } };
  expect(body.error?.details?.side).toBe("back");
});

/**
 * Fase 2 (RowingFederation-OCR) — VLM fallback tier. The real model is
 * never exercised here (that's RowingFederation-OCR's own test suite,
 * validated against real production images — see its CHANGELOG); this only
 * proves the Backend correctly threads extractionSource through to the
 * audit trail when the OCR service reports a document was resolved by the
 * fallback instead of the fast EasyOCR pass. ocr-stub/server.ts returns
 * MATCHED + extractionSource: "vlm" whenever documentNumber contains
 * "OCRVLM".
 */
test("identity doc resolved by the VLM fallback tier is audit-logged with extractionEngine: vlm @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");
  const documentNumber = `OCRVLM${randomUUID().slice(0, 3)}`;
  const athleteId = await createAthlete(token, clubs.club1, documentNumber);

  await api.postMultipart(
    `/athletes/${athleteId}/requirements/identity-doc`,
    pngFormData(documentNumber, "2020-01-01"),
    token
  );

  const finalStatus = await pollUntilNotProcessing(athleteId, token);
  expect(finalStatus).toBe("APPROVED");

  const requirements = await api.get<{ data: { id: string } }>(
    `/athletes/${athleteId}/requirements`,
    token
  );

  interface AuditLogsResponse {
    data: {
      auditLogs: Array<{ action: string; changes: Record<string, any> }>;
    };
  }

  const logs = await api.get<AuditLogsResponse>(
    `/audit-logs/entity/AthleteRequirements/${requirements.data.id}`,
    token
  );
  const ocrLog = logs.data.auditLogs.find(
    (l) => l.action === "STATUS_CHANGE" && l.changes.entityData?.documentType === "identityDoc"
  );
  expect(ocrLog).toBeDefined();
  expect(ocrLog?.changes.entityData?.extractionEngine).toBe("vlm");
});
