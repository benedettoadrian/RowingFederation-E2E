import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Fase 7.5 — OCR circuit breaker. ocr-http-client.service.ts:
 * CIRCUIT_FAILURE_THRESHOLD=5 (consecutive), CIRCUIT_OPEN_MS=30_000,
 * hardcoded, not env-configurable. After 5 consecutive real failures
 * (non-2xx/timeout/connection-error — NOT the OCRFAIL marker, which is a
 * normal 200/REVIEW response and would call recordSuccess(), resetting the
 * counter), the 6th call short-circuits to REVIEW with reviewNote "OCR
 * service temporarily unavailable" WITHOUT calling the OCR service at all.
 *
 * ocr-stub/server.ts gained a new marker for this test: documentNumber
 * containing "OCRDOWN" returns a real HTTP 500 (recordFailure()), distinct
 * from "OCRFAIL" (200/REVIEW, recordSuccess()).
 *
 * Caveat: the circuit breaker is in-process singleton state on the
 * backend, shared across every test in the suite. If another test's real
 * OCR call (e.g. document-upload.spec.ts) lands between two of this test's
 * 5 forced failures, it calls recordSuccess() and resets the counter,
 * making this test flaky under parallel execution. Accepted as a known,
 * narrow-window risk rather than adding cross-file test isolation
 * machinery for one circuit-breaker test — rerun if it flakes.
 */

async function createAthleteAndUpload(
  adminToken: string,
  clubId: string,
  documentNumber: string
): Promise<string> {
  const athlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "OCRBreaker",
      firstSurname: randomUUID().slice(0, 8),
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber,
      currentClubId: clubId,
    },
    adminToken
  );

  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  form.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  form.append("emissionDate", "2020-01-01");
  // Backend requires expirationDate for athletes under 60 (this fixture's
  // athlete is always 2000-01-01) — see upload-identity-doc.use-case.ts.
  form.append("expirationDate", "2033-01-01");
  await api.postMultipart(`/athletes/${athlete.data.id}/requirements/identity-doc`, form, adminToken);

  return athlete.data.id;
}

async function pollUntilSettled(athleteId: string, token: string, maxWaitMs = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await api.get<{ data: { identityDoc: { status: string; reviewNote?: string } } }>(
      `/athletes/${athleteId}/requirements`,
      token
    );
    const { status } = res.data.identityDoc;
    if (status !== "PROCESSING" && status !== "PENDING_UPLOAD") {
      return res.data.identityDoc.reviewNote ?? "";
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`OCR processing did not settle within ${maxWaitMs}ms`);
}

test("5 consecutive OCR failures open the circuit; the 6th call short-circuits to REVIEW without calling OCR @tier1", async () => {
  // This test forces the circuit open and it stays that way for
  // CIRCUIT_OPEN_MS (30s, hardcoded in ocr-http-client.service.ts). It runs
  // in its own isolated Playwright project that every other project
  // depends on (see playwright.config.ts) — so it must wait out the open
  // window and confirm recovery itself before finishing, or every real OCR
  // call in the next project would get short-circuited too.
  test.setTimeout(75_000);
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();

  for (let i = 0; i < 5; i++) {
    const athleteId = await createAthleteAndUpload(
      adminToken,
      clubs.club1,
      `OCRDOWN${randomUUID().slice(0, 4)}`
    );
    const reason = await pollUntilSettled(athleteId, adminToken);
    expect(reason).not.toContain("temporarily unavailable");
  }

  // No OCRDOWN/OCRFAIL marker — would MATCH under a healthy circuit. If it
  // instead resolves to REVIEW with the circuit's own message, the OCR
  // service was never actually called for this one.
  const sixthAthleteId = await createAthleteAndUpload(
    adminToken,
    clubs.club1,
    `OK${randomUUID().slice(0, 6)}`
  );
  const sixthReason = await pollUntilSettled(sixthAthleteId, adminToken);
  expect(sixthReason).toContain("temporarily unavailable");

  // Wait out CIRCUIT_OPEN_MS and confirm the circuit actually recovers —
  // leaves the backend in a known-good state for every test that runs
  // after this project.
  await new Promise((r) => setTimeout(r, 31_000));
  const recoveredAthleteId = await createAthleteAndUpload(
    adminToken,
    clubs.club1,
    `OK${randomUUID().slice(0, 6)}`
  );
  const recoveredReason = await pollUntilSettled(recoveredAthleteId, adminToken);
  expect(recoveredReason).not.toContain("temporarily unavailable");
});
