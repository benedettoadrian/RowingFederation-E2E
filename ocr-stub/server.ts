/**
 * OCR Stub — deterministic double of RowingFederation-OCR for the E2E stack.
 *
 * Mirrors the REAL response shapes from RowingFederation-OCR/models.py +
 * services/document_validator.py + services/consent_validator.py exactly
 * (nested `extracted` object, camelCase `reviewReason`/`matchDetails`) —
 * NOT the shape the backend's ocr-http-client.service.ts currently parses
 * (flat snake_case `review_reason`/`extracted_document_number`). That
 * mismatch is a real contract bug between Backend and OCR found while
 * building this stub (backend never actually reads reviewReason/extracted
 * fields back from a real OCR response — see E2E repo README). Keeping the
 * stub faithful to the real service is what lets an E2E test surface that
 * bug instead of hiding it.
 *
 * Deterministic control via magic markers in the request (no stateful
 * control endpoint — keeps parallel Playwright workers from racing each
 * other over shared stub state):
 *   - documentNumber containing "OCRFAIL"        -> /extract-document returns REVIEW
 *   - athleteDocumentNumber containing "OCRFAIL"  -> /validate-consent returns REVIEW
 *   - uploaded filename containing "BADIMG"       -> /validate-image returns REJECTED
 *   - documentNumber containing "OCRDOWN"         -> /extract-document returns 500
 *     (a real HTTP failure, unlike OCRFAIL's 200/REVIEW — needed to drive
 *     ocr-http-client.service.ts's circuit breaker, which only counts
 *     non-2xx/timeout/connection-error as a failure via recordFailure())
 *   - documentNumber containing "OCRVLM"          -> /extract-document returns
 *     MATCHED with extractionSource: "vlm" — simulates the real OCR
 *     service's Fase 2 fallback tier (see RowingFederation-OCR's
 *     services/vlm_extractor.py) resolving a document the fast EasyOCR
 *     pass alone couldn't. This stub never runs an actual model; it only
 *     needs to prove the Backend correctly threads extractionSource
 *     through to the audit trail (entityData.extractionEngine) — the real
 *     VLM's own accuracy is validated separately, against real production
 *     images, in RowingFederation-OCR's own test suite and CHANGELOG.
 *   - uploaded filename containing "FACEDETECTED"  -> /detect-face returns
 *     a fixed bounding box instead of the default faceDetected: false.
 *     Real Haar Cascade face detection is validated separately, against
 *     synthetic and real cases, in RowingFederation-OCR's own
 *     test_face_detector.py — this stub only needs to prove the Backend
 *     correctly wires the call and applies the resulting crop.
 */
import express from "express";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT ?? "8001";
const INTERNAL_API_KEY = process.env.STUB_INTERNAL_API_KEY ?? "";

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!INTERNAL_API_KEY) return next(); // fail-open by default, matches real service's local-dev behavior
  const provided = req.header("x-internal-service-key");
  if (provided !== INTERNAL_API_KEY) {
    res.status(401).json({ detail: "Missing or invalid X-Internal-Service-Key" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "ocr-stub", version: "0.1.0" });
});

app.post("/validate-image", upload.single("file"), (req, res) => {
  const filename = req.file?.originalname ?? "";
  if (filename.includes("BADIMG")) {
    res.status(200).json({
      status: "REJECTED",
      issues: ["blurry", "low_resolution"],
      confidence: 0.2,
    });
    return;
  }
  res.status(200).json({ status: "OK", issues: [], confidence: 0.95 });
});

app.post("/detect-face", upload.single("file"), (req, res) => {
  const filename = req.file?.originalname ?? "";
  if (filename.includes("FACEDETECTED")) {
    res.status(200).json({ faceDetected: true, x: 40, y: 30, width: 80, height: 90 });
    return;
  }
  res.status(200).json({ faceDetected: false });
});

app.post("/extract-document", upload.single("file"), (req, res) => {
  const documentNumber = String(req.body.documentNumber ?? "");
  const emissionDate = String(req.body.emissionDate ?? "");
  const expirationDate = req.body.expirationDate as string | undefined;
  const birthDate = req.body.birthDate as string | undefined;
  const firstName = req.body.firstName as string | undefined;
  const lastName = req.body.lastName as string | undefined;

  if (documentNumber.includes("OCRDOWN")) {
    res.status(500).json({ detail: "Simulated OCR service failure (E2E stub)" });
    return;
  }

  const forceReview = documentNumber.includes("OCRFAIL");
  const forceVlmResolved = documentNumber.includes("OCRVLM");

  const extracted = {
    documentNumber,
    birthDate: birthDate ?? null,
    emissionDate,
    expirationDate: expirationDate ?? null,
    firstName: firstName ?? null,
    lastName: lastName ?? null,
    nationality: "URU",
    mrzLine1: null,
    mrzLine2: null,
    extractionConfidence: forceReview ? 0.3 : 0.97,
    rawText: null,
  };

  if (forceReview) {
    res.status(200).json({
      status: "REVIEW",
      extracted,
      matchDetails: { documentNumber: false },
      reviewReason: "Simulated OCR review (E2E stub — documentNumber contains OCRFAIL)",
      rawText: null,
    });
    return;
  }

  res.status(200).json({
    status: "MATCHED",
    extracted,
    matchDetails: {
      documentNumber: true,
      expirationDate: true,
      emissionDate: true,
      birthDate: true,
    },
    reviewReason: null,
    rawText: null,
    ...(forceVlmResolved && { extractionSource: "vlm" }),
  });
});

app.post("/validate-consent", upload.single("file"), (req, res) => {
  const athleteDocumentNumber = String(req.body.athleteDocumentNumber ?? "");
  const forceReview = athleteDocumentNumber.includes("OCRFAIL");

  if (forceReview) {
    res.status(200).json({
      status: "REVIEW",
      missingFields: ["signatures"],
      reviewReason: "Simulated consent review (E2E stub — athleteDocumentNumber contains OCRFAIL)",
    });
    return;
  }

  res.status(200).json({ status: "APPROVED", missingFields: [], reviewReason: null });
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`[ocr-stub] listening on :${PORT}`);
});
