import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { API_URL } from "../../fixtures/lib/config.js";
import { makeProfilePhotoPng } from "../../fixtures/lib/photo.js";

/**
 * Athlete creation — golden paths. Verified against
 * athlete-validation.dto.ts's CreateAthleteDtoSchema before writing: required
 * fields are firstName, firstSurname, gender, birthdate, nationality,
 * documentType, documentNumber, currentClubId — everything else
 * (secondName, secondSurname, nameDisplay, status) is optional.
 */

test("golden path: creates an athlete with only the minimum required fields", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();

  const created = await api.post<{
    data: { id: string; firstName: string; firstSurname: string; status: string };
  }>(
    "/athletes",
    {
      firstName: "Minimo",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `MIN${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      currentClubId: clubs.club1,
    },
    adminToken
  );

  expect(created.data.id).toBeTruthy();
  expect(created.data.firstName).toBe("Minimo");
  // No status sent -> defaults to PENDING_APPROVAL (create-athlete.use-case.ts).
  expect(created.data.status).toBe("PENDING_APPROVAL");
});

test("creates an athlete with every field plus a profile photo, and it renders on the athlete's profile page", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();
  const suffix = randomUUID().slice(0, 8);

  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Completo",
      secondName: "Segundo",
      firstSurname: `Test${suffix}`,
      secondSurname: "SegundoApellido",
      nameDisplay: "FIRST_ONLY",
      gender: "FEMALE",
      birthdate: "1995-06-15",
      nationality: "AR",
      documentType: "NATIONAL_ID",
      // NATIONAL_ID requires exactly 8 digits (see athlete-validation.dto.ts) — no letters.
      documentNumber: String(10000000 + Math.floor(Math.random() * 89999999)),
      currentClubId: clubs.club1,
      status: "ACTIVE",
    },
    adminToken
  );
  const athleteId = created.data.id;

  const originalPhotoBytes = makeProfilePhotoPng();
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(originalPhotoBytes)], { type: "image/png" }), "profile.png");
  const uploaded = await api.postMultipart<{ data: { profilePhoto: string } }>(
    `/athletes/${athleteId}/upload-photo`,
    form,
    adminToken
  );
  expect(uploaded.data.profilePhoto).toBeTruthy();

  // Exercises the real Backend -> OCR service `/detect-face` call over the
  // Docker network (auto-crop feature) end-to-end, not a mock. This fixture
  // is a synthetic checkerboard (see photo.ts) with no real face, so the
  // fail-open path (faceDetected: false) is the deterministic, correct
  // outcome — the photo is expected to reach storage byte-for-byte
  // unchanged, not resized/re-encoded by the crop step. A synthetic image
  // that Haar Cascade reliably detects AS a face isn't something that can
  // be fabricated deterministically, so the "a face IS found and gets
  // cropped" path is covered at the unit level instead (Backend's
  // upload-photo.use-case.spec.ts + OCR's test_face_detector.py), not here.
  const storedPhoto = await fetch(`${API_URL}/files/${uploaded.data.profilePhoto}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(storedPhoto.ok).toBe(true);
  const storedBytes = Buffer.from(await storedPhoto.arrayBuffer());
  expect(storedBytes.equals(originalPhotoBytes)).toBe(true);

  await loginAs(page, "ADMIN");
  await page.goto(`/es/athletes/${athleteId}`);

  // useAuthImageUrl() fetches the photo through the authenticated /files
  // proxy and swaps the <img src> to a blob: URL once it resolves — waiting
  // for that is what actually proves the photo rendered, not just that the
  // upload call succeeded.
  const photo = page.getByAltText("Completo");
  await expect(photo).toHaveAttribute("src", /^blob:/, { timeout: 10_000 });
});

test("a CLUB_DELEGATE creating an athlete sees their own club locked in, not a club picker @tier0", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const { clubs } = loadFixtures();
  const club = await api.get<{ data: { name: string } }>(`/clubs/${clubs.club1}`, adminToken);

  await loginAs(page, "CLUB_DELEGATE");
  await page.goto("/es/athletes/new");

  await expect(page.getByText(club.data.name)).toBeVisible();
  await expect(page.getByRole("combobox", { name: /club/i })).toHaveCount(0);
});
