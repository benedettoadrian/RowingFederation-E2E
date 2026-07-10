import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

// Fase 4.3 — club creation golden path + validation. ADMIN/FEDERATION_ADMIN
// only (CLUB_DELEGATE etc. get 403, not covered here — that's a permission-
// matrix concern, not a club-creation one).

function clubPayload(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID().slice(0, 8);
  // Independent randomUUID call for the abbreviation, not derived from
  // `suffix` — a 4-char slice of an 8-char suffix collided under parallel
  // test execution across this suite's growing number of club creations.
  const abbreviation = randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();
  return {
    name: `Club Create Test ${suffix}`,
    abbreviation,
    addressCountry: "Uruguay",
    addressState: "Montevideo",
    addressCity: "Montevideo",
    addressStreet: "Rambla Sur 123",
    addressPostalCode: "11000",
    email: `club-create-${suffix}@e2e.test`,
    foundationDate: "1950-01-01",
    affiliationDate: "1950-01-01",
    ...overrides,
  };
}

test("golden path: ADMIN creates a club @tier0", async () => {
  const token = await apiLoginAs("ADMIN");
  const payload = clubPayload();

  const created = await api.post<{ data: { id: string; name: string; abbreviation: string } }>(
    "/clubs",
    payload,
    token
  );

  expect(created.data.name).toBe(payload.name);
  expect(created.data.abbreviation).toBe(payload.abbreviation);
});

test("rejects a duplicate club name @tier0", async () => {
  const token = await apiLoginAs("ADMIN");
  const payload = clubPayload();

  await api.post("/clubs", payload, token);

  await expect(
    api.post("/clubs", clubPayload({ name: payload.name }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("rejects a duplicate abbreviation @tier0", async () => {
  const token = await apiLoginAs("ADMIN");
  const payload = clubPayload();

  await api.post("/clubs", payload, token);

  await expect(
    api.post("/clubs", clubPayload({ abbreviation: payload.abbreviation }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("rejects a lowercase abbreviation (schema requires uppercase A-Z0-9) @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  await expect(
    api.post("/clubs", clubPayload({ abbreviation: "abcd" }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("rejects an invalid email @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  await expect(
    api.post("/clubs", clubPayload({ email: "not-an-email" }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
