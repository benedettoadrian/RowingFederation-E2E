import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

// Fase 5.1 — championship (CIRCUIT type). Enum value is CIRCUIT, not
// CIRCUITO, despite the Spanish task description — verified against
// prisma/schema.prisma's ChampionshipType enum before writing this.

function championshipPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: `Circuito E2E ${randomUUID().slice(0, 8)}`,
    type: "CIRCUIT",
    dateFrom: "2026-03-01T00:00:00.000Z",
    dateTo: "2026-11-30T00:00:00.000Z",
    ...overrides,
  };
}

test("golden path: REGATTA_COMMISSION creates a CIRCUIT championship @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  const payload = championshipPayload();

  const created = await api.post<{ data: { id: string; name: string; type: string } }>(
    "/competitions/championships",
    payload,
    token
  );

  expect(created.data.name).toBe(payload.name);
  expect(created.data.type).toBe("CIRCUIT");
});

test("rejects a duplicate championship name @tier0", async () => {
  const token = await apiLoginAs("ADMIN");
  const payload = championshipPayload();

  await api.post("/competitions/championships", payload, token);

  await expect(
    api.post("/competitions/championships", championshipPayload({ name: payload.name }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("rejects dateFrom after dateTo @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  await expect(
    api.post(
      "/competitions/championships",
      championshipPayload({ dateFrom: "2026-12-01T00:00:00.000Z", dateTo: "2026-01-01T00:00:00.000Z" }),
      token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("CLUB_DELEGATE cannot create a championship @tier0", async () => {
  const token = await apiLoginAs("CLUB_DELEGATE");

  await expect(
    api.post("/competitions/championships", championshipPayload(), token)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});
