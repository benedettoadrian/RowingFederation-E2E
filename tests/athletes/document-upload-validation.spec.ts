import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 7.4 — identity-doc upload validation (multer). Max size is
 * env.MAX_IMAGE_SIZE (5MB default). fileFilter rejects non-JPEG/PNG
 * mimetypes.
 *
 * KNOWN GAP found while writing this: neither the bad-mimetype nor the
 * oversized-file case ever reach a clean 400. This route never wires
 * handleMulterError (that helper exists in file-upload.middleware.ts but
 * is unused anywhere in the codebase) — both a fileFilter Error and a
 * multer.MulterError fall through to globalErrorHandler, which doesn't
 * recognize either error type and wraps them as InternalServerError:
 * **HTTP 500**, not 400. Pinned as-is per the user's 2026-07-10 decision to
 * document rather than fix production code in this pass — do not "fix"
 * this test to expect 400 without first fixing
 * athlete-requirements.routes.ts's multer wiring and getting sign-off.
 */

async function createAthlete(adminToken: string, clubId: string): Promise<string> {
  const athlete = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "UploadValidation",
      firstSurname: randomUUID().slice(0, 8),
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "Uruguay",
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

test("KNOWN GAP: an oversized file returns 500, not a clean 400 @tier1", async () => {
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

  await expect(
    api.postMultipart(`/athletes/${athleteId}/requirements/identity-doc`, form, adminToken)
  ).rejects.toMatchObject({ status: 500 } satisfies Partial<ApiError>);
});
