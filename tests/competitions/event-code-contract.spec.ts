import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";

/**
 * T10/DRY-2 — contract test for the event-code format duplicated between
 * Backend (EventCodeVO) and Frontend (event-code.utils.ts's
 * generateEventCode, mirrored by hand — see that file's own comment
 * acknowledging it). No single source of truth exists across the two repos
 * without a shared package (a bigger infra decision, out of scope here);
 * this is the agreed mitigation: create a real event through the Backend
 * API, separately read what the Frontend's own live preview
 * (EventCodePreview.tsx, using the Frontend's copy of the algorithm)
 * computes for the exact same inputs *before* submitting, and assert both
 * sides produced the identical code. If either repo's copy of the format
 * ever drifts from the other, this test catches it — it does not (and
 * cannot, without a shared package) prevent the drift itself.
 */
test("event code shown by the Frontend's live preview matches the code the Backend actually persists @tier1", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const boatCode = `1X${suffix}`;
  const categoryName = `SENIOR-${suffix}`;

  const boat = await api.post<{ data: { id: string; code: string } }>(
    "/competitions/boats",
    {
      code: boatCode,
      name: `Contract Test Boat ${suffix}`,
      type: "SHELL",
      athleteCount: 1,
      hasCoxswain: false,
    },
    adminToken
  );

  const ageCategory = await api.post<{ data: { id: string; name: string } }>(
    "/competitions/age-categories",
    { name: categoryName, minAge: 19, maxAge: null },
    adminToken
  );

  await loginAs(page, "ADMIN");
  await page.goto("/es/competitions/events");

  await page.getByRole("button", { name: "Nueva prueba" }).click();

  await page.getByLabel("Nombre").fill(`Contract test event ${suffix}`);

  await page.getByLabel("Embarcación").click();
  await page.getByRole("option", { name: boatCode }).click();

  await page.getByLabel("Categoría de edad").click();
  await page.getByRole("option", { name: categoryName }).click();

  await page.getByLabel("Género").click();
  await page.getByRole("option", { name: "Masculino" }).click();

  // The live preview (Frontend's own generateEventCode) — read before
  // submitting, this is the Frontend side of the contract.
  const previewCode = await page.locator("p.font-mono.text-lg").innerText();
  expect(previewCode).toMatch(new RegExp(`^${boatCode}-`));

  await page.getByRole("button", { name: "Crear prueba" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });

  // The Backend side of the contract: fetch the just-created event and
  // compare its persisted `code` against what the Frontend previewed.
  const events = await api.get<{ data: Array<{ code: string; boatId: string; ageCategoryId: string }> }>(
    `/competitions/events?boatId=${boat.data.id}&ageCategoryId=${ageCategory.data.id}`,
    adminToken
  );
  expect(events.data.length).toBeGreaterThan(0);
  const backendCode = events.data[0]!.code;

  expect(backendCode).toBe(previewCode);
});
