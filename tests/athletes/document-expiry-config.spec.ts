import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Configuración de días de aviso de vencimiento de documentos, editable
 * desde /settings (delegado de club y comisión de regatas ven el aviso
 * en su panel del dashboard con esta cantidad de días de anticipación).
 * Ver [[fur-novice-category-eligibility-plan]] sibling work — panel de
 * delegados, ahora configurable en vez de fijo en 20 días.
 */

test("document-expiry-config: GET returns a config row, defaulting to 20 days @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const result = await api.get<{ data: { id: string; expiryWarningDays: number } }>(
    "/athletes/document-expiry-config",
    adminToken
  );

  expect(typeof result.data.id).toBe("string");
  expect(result.data.expiryWarningDays).toBeGreaterThan(0);
});

test("document-expiry-config: REGATTA_COMMISSION can update it, and expiring-documents reflects the new threshold @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const original = await api.get<{ data: { expiryWarningDays: number } }>(
    "/athletes/document-expiry-config",
    regattaToken
  );

  try {
    const updated = await api.put<{ data: { expiryWarningDays: number } }>(
      "/athletes/document-expiry-config",
      { expiryWarningDays: 45 },
      regattaToken
    );
    expect(updated.data.expiryWarningDays).toBe(45);

    // expiring-documents with no explicit daysAhead falls back to the configured value
    const expiring = await api.get<{ data: { thresholdDays: number } }>(
      "/athletes/expiring-documents",
      regattaToken
    );
    expect(expiring.data.thresholdDays).toBe(45);

    // an explicit daysAhead still overrides the configured default
    const explicit = await api.get<{ data: { thresholdDays: number } }>(
      "/athletes/expiring-documents?daysAhead=7",
      regattaToken
    );
    expect(explicit.data.thresholdDays).toBe(7);
  } finally {
    await api.put(
      "/athletes/document-expiry-config",
      { expiryWarningDays: original.data.expiryWarningDays },
      regattaToken
    );
  }
});

test("document-expiry-config: rejects a CLUB_DELEGATE trying to update it (regatta-manager only) @tier0", async () => {
  const delegateToken = await apiLoginAs("CLUB_DELEGATE");
  await expect(
    api.put("/athletes/document-expiry-config", { expiryWarningDays: 10 }, delegateToken)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});

test("document-expiry-config: rejects an out-of-range value @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  await expect(
    api.put("/athletes/document-expiry-config", { expiryWarningDays: 0 }, regattaToken)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
  await expect(
    api.put("/athletes/document-expiry-config", { expiryWarningDays: 400 }, regattaToken)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
