import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Real production report (2026-09-09): a delegate opens an athlete whose
 * card was approved/auto-verified long ago and has since expired, and sees
 * it displayed as green/valid instead of red/expired — athleteCardStatus is
 * set once at verification/approval time and never re-evaluated afterwards
 * (the expiry scheduler only deactivates the athlete, it never corrects
 * this field). Fixed in athlete-requirements.controller.ts's mapToDto:
 * expose a date-aware effective status instead of the raw stored one.
 *
 * FEDERATION_ADMIN (not ADMIN) throughout — same rate-limit note as
 * document-upload.spec.ts / nationality-eligibility.spec.ts:
 * documentUploadRateLimiter is 20 req/15min under NODE_ENV=production
 * (which this E2E stack deliberately runs with), keyed per-user.
 */

interface RequirementsResponse {
  data: {
    athleteCard: { status: string; endDate: string | null };
  };
}

async function createAthlete(token: string, clubId: string, documentNumber: string) {
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Card",
      firstSurname: `Expiry${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber,
      currentClubId: clubId,
    },
    token
  );
  return created.data.id as string;
}

async function uploadAndApproveExpiredCard(athleteId: string, token: string) {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("card", new Blob([bytes], { type: "image/png" }), "card.png");
  form.append("startDate", "2024-01-01");
  form.append("endDate", "2024-12-31"); // long expired — today is 2026-09-09

  await api.postMultipart(`/athletes/${athleteId}/requirements/athlete-card`, form, token);

  await api.put(
    `/athletes/${athleteId}/requirements/athlete-card/review`,
    { action: "approve" },
    token
  );
}

test("athleteCard.status is EXPIRED (not APPROVED) once athleteCardEndDate has passed @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("FEDERATION_ADMIN");
  const athleteId = await createAthlete(token, clubs.club1, `CE${randomUUID().slice(0, 8)}`);

  await uploadAndApproveExpiredCard(athleteId, token);

  const res = await api.get<RequirementsResponse>(`/athletes/${athleteId}/requirements`, token);
  expect(res.data.athleteCard.status).toBe("EXPIRED");
  expect(res.data.athleteCard.endDate).toContain("2024-12-31");
});

test("the athlete page shows the expired card in red, not green @tier0", async ({ page }) => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("FEDERATION_ADMIN");
  const athleteId = await createAthlete(token, clubs.club1, `CE${randomUUID().slice(0, 8)}`);

  await uploadAndApproveExpiredCard(athleteId, token);

  await loginAs(page, "FEDERATION_ADMIN");
  await page.goto(`/es/athletes/${athleteId}`);
  // messages/es.json: athletes.cardExpiredMsg = "Ficha vencida"
  await expect(page.getByText("Ficha vencida")).toBeVisible({ timeout: 10_000 });
  // The green "approved" box (athletes.cardApprovedManual) must NOT show.
  await expect(page.getByText("Ficha aprobada manualmente")).toHaveCount(0);
});
