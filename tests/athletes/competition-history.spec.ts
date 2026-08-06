import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Golden path for the athlete competition-history feature — real browser,
 * real backend, real DB. Confirms the button on the athlete profile
 * navigates to the new page, and that a FINISHED result renders with the
 * expected participation status badge.
 */
test("athlete profile links to competition history, which renders a real result", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const adminToken = await apiLoginAs("ADMIN");
  const fx = await setupInscriptionFixtures(regattaToken, { advanceToClosed: true });

  const entry = await api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    {
      competitionDateId: fx.competitionDateId,
      eventId: fx.eventId,
      clubId: fx.club1Id,
      members: [{ athleteId: fx.club1.athleteId, role: "ROWER" }],
      adminOverride: true,
    },
    adminToken
  );
  await api.put(
    `/competitions/crew-entries/${entry.data.id}/result`,
    { resultCode: "FINISHED", position: 1, time: "6:15.00" },
    adminToken
  );

  await loginAs(page, "ADMIN");
  await page.goto(`/es/athletes/${fx.club1.athleteId}`);

  await page.getByRole("link", { name: /historial en competencias/i }).click();
  await expect(page).toHaveURL(new RegExp(`/athletes/${fx.club1.athleteId}/historial`));

  const seasonYear = fx.date.slice(0, 4);
  await expect(page.getByText(seasonYear)).toBeVisible(); // season group header

  // fx's competitionDate is a random future year (birthday-paradox-safe
  // fixture), so it's never the current year — only the current season is
  // expanded by default, this one starts collapsed. Expand it.
  await page.getByRole("button", { name: new RegExp(seasonYear) }).click();

  await expect(page.getByText("Completó")).toBeVisible(); // FINISHED participation status
  await expect(page.getByText("Posición 1")).toBeVisible();
});
