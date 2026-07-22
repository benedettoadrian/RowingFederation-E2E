import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Club creation is requiresFederationAdmin() only (club.routes.ts:60-61) —
 * ADMIN/FEDERATION_ADMIN, nobody else. REGATTA_COMMISSION and director
 * roles (PRESIDENT etc.) are NOT in that group, verified against source
 * before writing these as rejection cases rather than assuming.
 *
 * The public club listing (GET /es/clubes, unauthenticated) reads GET
 * /api/v1/clubs (optionalAuthMiddleware — no token needed) and renders
 * logo, name, abbreviation, founded/affiliated years, city/state, street,
 * phone and website for every ACTIVE club — verified against
 * (public)/clubes/page.tsx before writing the assertions below.
 */

function fullClubPayload(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID().slice(0, 8);
  return {
    name: `Club Completo E2E ${suffix}`,
    abbreviation: randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase(),
    logo: "https://images.unsplash.com/photo-1517649763962-0c623066013b?w=200&h=200&fit=crop",
    addressCountry: "Uruguay",
    addressState: "Montevideo",
    addressCity: "Montevideo",
    addressStreet: `Rambla Sur ${Math.floor(Math.random() * 9000) + 100}`,
    addressPostalCode: "11000",
    website: "https://example.com",
    phone: "+598 99 123 456",
    email: `club-full-${suffix}@e2e.test`,
    foundationDate: "1950-01-01",
    affiliationDate: "1950-01-01",
    ...overrides,
  };
}

test("REGATTA_COMMISSION cannot create a club", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  await expect(api.post("/clubs", fullClubPayload(), token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("a director role (PRESIDENT) cannot create a club", async () => {
  const token = await apiLoginAs("PRESIDENT");
  await expect(api.post("/clubs", fullClubPayload(), token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("ADMIN creates a club with full data plus a logo, and everything is visible on the public clubs page", async ({
  page,
}) => {
  const token = await apiLoginAs("ADMIN");
  const payload = fullClubPayload();

  const created = await api.post<{ data: { id: string; status: string } }>(
    "/clubs",
    payload,
    token
  );
  expect(created.data.status).toBe("ACTIVE"); // default when not sent — required for the public list

  await page.goto("/es/clubes");

  const card = page.locator("div.border-slate-200", { hasText: payload.name });
  await expect(card).toBeVisible();
  await expect(card.getByAltText(payload.name)).toBeVisible();
  await expect(card.getByText(payload.abbreviation)).toBeVisible();
  await expect(card.getByText(new RegExp(`${payload.addressCity}, ${payload.addressState}`))).toBeVisible();
  await expect(card.getByText(payload.addressStreet)).toBeVisible();
  await expect(card.getByText(payload.phone)).toBeVisible();
  await expect(card.locator(`a[href="${payload.website}"]`)).toBeVisible();
});
