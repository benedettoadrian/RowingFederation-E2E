import { test, expect } from "@playwright/test";
import { loginAs, loadFixtures } from "../../fixtures/auth.js";
import { API_URL } from "../../fixtures/lib/config.js";

// Fase 3.3 — a CLUB_DELEGATE must not be able to view an athlete belonging
// to a different club by navigating directly to its URL. Backend enforces
// this in the controller itself (athlete.controller.ts, inline club-scope
// check on GET /:id) — this test proves the real 403 reaches the UI, not
// just that the endpoint exists.
test("CLUB_DELEGATE cannot view another club's athlete via direct URL @tier0", async ({
  page,
}) => {
  const { athletes } = loadFixtures();

  await loginAs(page, "CLUB_DELEGATE"); // scoped to club1

  // Anchored to the exact backend API URL, not a loose substring — the
  // frontend page route (localhost:5174/es/athletes/:id) contains the same
  // athlete-id substring and its 200 page-shell response arrives before the
  // client ever calls the backend, so a loose match resolves on the wrong
  // response and silently passes.
  const responsePromise = page.waitForResponse(
    (res) => res.url() === `${API_URL}/api/v1/athletes/${athletes.club2}` && res.request().method() === "GET"
  );
  await page.goto(`/es/athletes/${athletes.club2}`);
  const response = await responsePromise;

  expect(response.status()).toBe(403);
  // athletes/[id]/page.tsx renders this on isError, no redirect — see
  // useAthlete()'s isError branch.
  await expect(page.getByText("Error al cargar los datos")).toBeVisible();
});

test("CLUB_DELEGATE can view its own club's athlete @tier0", async ({ page }) => {
  const { athletes } = loadFixtures();

  await loginAs(page, "CLUB_DELEGATE"); // scoped to club1

  const responsePromise = page.waitForResponse(
    (res) => res.url() === `${API_URL}/api/v1/athletes/${athletes.club1}` && res.request().method() === "GET"
  );
  await page.goto(`/es/athletes/${athletes.club1}`);
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  await expect(page.getByText("Error al cargar los datos")).not.toBeVisible();
});
