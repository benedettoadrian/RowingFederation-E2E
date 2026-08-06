import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 7.4 — identity-doc upload validation (multer). Max size is
 * env.MAX_IMAGE_SIZE (5MB default). fileFilter rejects non-JPEG/PNG
 * mimetypes.
 *
 * KNOWN GAP (bad mimetype only, still open): this route's fileFilter
 * rejects with a plain `new Error(...)`, not a DomainError, so it isn't
 * recognized by globalErrorHandler and falls through as HTTP 500 instead of
 * a clean 400. Pinned as-is — fixing it means teaching
 * athlete-requirements.routes.ts's 3 inline multer fileFilters to throw
 * InvalidFileTypeError instead of a plain Error, out of scope here.
 *
 * The oversized-file case (T18/BE-5, fixed 2026-07-12) is different: that's
 * multer's own `limits.fileSize` enforcement, which raises a real
 * `multer.MulterError`. `handleMulterError` (previously dead code, now
 * wired app-wide in express.app.ts) catches it and maps it to
 * DocumentTooLargeError, a real DomainError — so this now gets the clean
 * 400 contract like any other endpoint's oversized upload.
 */

async function createAthlete(adminToken: string, clubId: string): Promise<string> {
  const athlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "UploadValidation",
      firstSurname: randomUUID().slice(0, 8),
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `UV${randomUUID().slice(0, 8)}`,
      currentClubId: clubId,
    },
    adminToken
  );
  return athlete.data.id;
}

test("KNOWN GAP: uploading a .txt file as an identity document returns 500, not a clean 400 @tier1", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();
  const athleteId = await createAthlete(adminToken, clubs.club1);

  const form = new FormData();
  form.append("front", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "front.txt");
  form.append(
    "back",
    new Blob([Buffer.from(TINY_PNG_BASE64, "base64")], { type: "image/png" }),
    "back.png"
  );
  form.append("emissionDate", "2020-01-01");

  await expect(
    api.postMultipart(`/athletes/${athleteId}/requirements/identity-doc`, form, adminToken)
  ).rejects.toMatchObject({ status: 500 } satisfies Partial<ApiError>);
});

test("an oversized file returns a clean 400 with the DOCUMENT_TOO_LARGE contract (T18/BE-5) @tier1", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();
  const athleteId = await createAthlete(adminToken, clubs.club1);

  // MAX_IMAGE_SIZE default is 5MB (env.config.ts) — 6MB of arbitrary bytes
  // exceeds it regardless of E2E-stack-specific overrides. Not a real PNG
  // (fileFilter would reject it as bad-mimetype first if it were checked
  // before size, but multer's `limits` enforcement runs during streaming,
  // ahead of fileFilter's full read) — the point here is the size limit
  // specifically, not content validation.
  const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
  const form = new FormData();
  form.append("front", new Blob([oversized], { type: "image/png" }), "front.png");
  form.append(
    "back",
    new Blob([Buffer.from(TINY_PNG_BASE64, "base64")], { type: "image/png" }),
    "back.png"
  );
  form.append("emissionDate", "2020-01-01");

  try {
    await api.postMultipart(`/athletes/${athleteId}/requirements/identity-doc`, form, adminToken);
    throw new Error("expected the request to be rejected as too large");
  } catch (err) {
    const apiError = err as ApiError;
    expect(apiError.status).toBe(400);
    const body = apiError.body as { error: { code: string; details: { sizeInBytes: number } } };
    expect(body.error.code).toBe("DOCUMENT_TOO_LARGE");
    expect(body.error.details.sizeInBytes).toBeGreaterThan(0);
  }
});
