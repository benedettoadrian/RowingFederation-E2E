import { test, expect } from "@playwright/test";
import { loginAs, loadFixtures } from "../../fixtures/auth.js";
import { API_URL } from "../../fixtures/lib/config.js";

// Fase 3.3 (2026-07) originally required a CLUB_DELEGATE be blocked from
// viewing an athlete belonging to a different club — reversed 2026-08-06
// per a real user-reported bug: a delegate must be able to browse/view
// EVERY athlete in the system (list, profile, requirements/documents),
// same as any other role. Club scoping only applies to *write* actions —
// editing an athlete (frontend pencil + updateAthlete's assertClubScope)
// and uploading/reviewing a requirement document (still assertClubScope-
// gated, see tests/athletes/list-scoping.spec.ts for that coverage).
test("CLUB_DELEGATE can view another club's athlete via direct URL @tier0", async ({ page }) => {
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

  expect(response.status()).toBe(200);
  await expect(page.getByText("Error al cargar los datos")).not.toBeVisible();
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

test("CLUB_DELEGATE does not see the edit button on another club's athlete profile @tier0", async ({
  page,
}) => {
  const { athletes } = loadFixtures();

  await loginAs(page, "CLUB_DELEGATE"); // scoped to club1
  await page.goto(`/es/athletes/${athletes.club2}`);

  // Viewing is allowed, editing isn't — the pencil/edit action stays
  // club-scoped (athletes/[id]/page.tsx's canUpload/edit-link condition).
  await expect(page.getByRole("link", { name: /editar/i })).not.toBeVisible();
});
