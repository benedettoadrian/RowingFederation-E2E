import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 3.5 — permission matrix (read-only role vs. write-restricted actions).
 *
 * Direct API calls, not UI: both actions below have no corresponding UI flow
 * yet (athlete-card review / temporary eligibility override belong to Fases
 * 4-5, not built). The thing under test is the authorization boundary
 * itself, not a screen — asserting the exact HTTP status is more precise
 * than asserting on absent UI. Re-covered through the UI once those flows
 * exist.
 *
 * Original spec asked for "TREASURER sin acceso a datos médicos" — verified
 * against the backend (2026-07-10) that no such restriction exists: there's
 * no separate medical-data field/endpoint, and access control is entirely
 * role-array based with no field-level masking, so every authenticated role
 * reads the same athlete DTO. That's a design choice, not a bug, so it's not
 * asserted here. What IS real and verified: REFEREE has read-only access to
 * athletes — it cannot approve/reject an athlete card or grant a temporary
 * eligibility override, both ADMIN/reviewer-only actions.
 */
test("REFEREE cannot approve/reject an athlete card @tier0", async () => {
  const { athletes } = loadFixtures();
  const token = await apiLoginAs("REFEREE");

  await expect(
    api.put(
      `/athletes/${athletes.club1}/requirements/athlete-card/review`,
      { action: "approve" },
      token
    )
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("REFEREE cannot grant a temporary eligibility override @tier0", async () => {
  const { athletes } = loadFixtures();
  const token = await apiLoginAs("REFEREE");

  await expect(
    api.patch(`/athletes/${athletes.club1}/temporary-activate`, {}, token)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});
