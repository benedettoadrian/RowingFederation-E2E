import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
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
      nationality: "Uruguay",
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
      nationality: "Argentina",
      documentType: "NATIONAL_ID",
      // NATIONAL_ID requires exactly 8 digits (see athlete-validation.dto.ts) — no letters.
      documentNumber: String(10000000 + Math.floor(Math.random() * 89999999)),
      currentClubId: clubs.club1,
      status: "ACTIVE",
    },
    adminToken
  );
  const athleteId = created.data.id;

  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(makeProfilePhotoPng())], { type: "image/png" }), "profile.png");
  const uploaded = await api.postMultipart<{ data: { profilePhoto: string } }>(
    `/athletes/${athleteId}/upload-photo`,
    form,
    adminToken
  );
  expect(uploaded.data.profilePhoto).toBeTruthy();

  await loginAs(page, "ADMIN");
  await page.goto(`/es/athletes/${athleteId}`);

  // useAuthImageUrl() fetches the photo through the authenticated /files
  // proxy and swaps the <img src> to a blob: URL once it resolves — waiting
  // for that is what actually proves the photo rendered, not just that the
  // upload call succeeded.
  const photo = page.getByAltText("Completo");
  await expect(photo).toHaveAttribute("src", /^blob:/, { timeout: 10_000 });
});
