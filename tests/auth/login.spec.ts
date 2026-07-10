import { test, expect } from "@playwright/test";
import { loginAs, type RoleKey } from "../../fixtures/auth.js";

// Fase 3.1 — login × 11 roles. Each is its own test (not a loop with
// sub-expects) so a failure on one role doesn't hide failures on the rest,
// and Playwright's parallel workers can run them concurrently.
const ROLES: RoleKey[] = [
  "ADMIN",
  "FEDERATION_ADMIN",
  "PRESIDENT",
  "VICE_PRESIDENT",
  "GENERAL_SECRETARY",
  "TREASURER",
  "MINUTES_SECRETARY",
  "REGATTA_COMMISSION",
  "REFEREE",
  "CLUB_DELEGATE",
  "DELEGATE",
];

for (const role of ROLES) {
  test(`login as ${role} redirects to dashboard @tier0`, async ({ page }) => {
    await loginAs(page, role);
    await expect(page).toHaveURL(/\/(es|en|pt)\/dashboard/);
  });
}

test("logout invalidates the session @tier0", async ({ page }) => {
  await loginAs(page, "ADMIN");

  await page.getByTestId("user-menu-trigger").click();
  // Role-based locator, not getByTestId: the "logout-menu-item" data-testid
  // added to this DropdownMenuItem (Topbar.tsx) does not reach the DOM —
  // confirmed via page.evaluate() querySelector, root cause not yet found
  // (Radix DropdownMenuItem does spread ...props, so this needs follow-up;
  // logged in fixtures/README.md). The accessible role+name is confirmed
  // present and stable, so it's the correct tool here regardless.
  await page.getByRole("menuitem", { name: "Cerrar sesión", exact: true }).click();

  // handleLogout() in Topbar.tsx pushes to "/", not directly to /login —
  // the access token only ever lived in memory (Zustand, not persisted),
  // so re-requesting a protected route after that memory is cleared is
  // what actually proves the session is gone, not the immediate redirect.
  await page.goto("/es/dashboard");
  await page.waitForURL(/\/(es|en|pt)\/login/, { timeout: 10_000 });
});
