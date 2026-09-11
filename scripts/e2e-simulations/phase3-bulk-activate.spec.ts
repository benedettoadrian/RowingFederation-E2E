import { test, expect } from "@playwright/test";
import { SIM_PASSWORD } from "./config.js";
import { SIM_BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { simLogin } from "./lib/ui.js";

/**
 * Fase 3 of plan.md — ADMIN-only bulk 24h temporary activation
 * (bulkTemporaryActivate, athlete.routes.ts) so every athlete in the
 * recipe can be inscribed regardless of expired/missing documentation.
 * Idempotent by construction: the backend only grants the override to
 * athletes who don't already have a currently-valid one (see
 * BulkTemporaryActivateAthletesUseCase) — safe to click on every run.
 */
test("Fase 3 — habilitar atletas por 24h", async ({ page }) => {
  await simLogin(page, SIM_BOOTSTRAP_ADMIN_EMAIL, SIM_PASSWORD);
  await page.goto("/es/athletes");

  await page.getByRole("button", { name: "Habilitar todos por 24h" }).click();
  await page.getByRole("button", { name: "Habilitar todos", exact: true }).click();

  await expect(page.getByRole("button", { name: "Habilitar todos por 24h" })).toBeEnabled({
    timeout: 15_000,
  });
  console.log("Bulk 24h activation triggered.");
});
