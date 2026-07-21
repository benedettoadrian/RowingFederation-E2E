import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * New COMMUNICATIONS role (2026-07-21): manages news + contact inbox,
 * read-only everywhere else, free use of the ad-hoc handicap tool.
 * Shares the requiresNewsManage() guard with news/inbox — same access as
 * DELEGATE for those two resources, but NOT a director role and NOT in
 * ALL_ADMINS, so it must fail every admin-only write path below.
 */

function newsPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: `Noticia Comunicaciones E2E ${randomUUID().slice(0, 8)}`,
    excerpt: "Resumen corto de la noticia para pruebas E2E.",
    content: "Contenido completo de la noticia de prueba, con al menos diez caracteres.",
    ...overrides,
  };
}

test("COMMUNICATIONS: full news lifecycle — create, publish, unpublish, delete @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");

  const created = await api.post<{ data: { id: string; isPublished: boolean } }>(
    "/news",
    newsPayload(),
    token
  );
  expect(created.data.isPublished).toBe(false);
  const id = created.data.id;

  await api.patch(`/news/${id}/publish`, {}, token);
  const publicList = await api.get<{ data: Array<{ id: string }> }>("/news");
  expect(publicList.data.some((n) => n.id === id)).toBe(true);

  await api.patch(`/news/${id}/unpublish`, {}, token);
  await api.delete(`/news/${id}`, token);
  const afterDelete = await api.get<{ data: Array<{ id: string }> }>(
    "/news/admin/all",
    token
  );
  expect(afterDelete.data.some((n) => n.id === id)).toBe(false);
});

test("COMMUNICATIONS: sees the contact inbox and can mark a message as read @tier0", async () => {
  const submitted = await api.post<{ data: { id: string } }>("/public/contact", {
    fullName: "E2E Contact",
    email: `contact-${randomUUID().slice(0, 8)}@e2e.test`,
    subject: `Consulta Comunicaciones ${randomUUID().slice(0, 8)}`,
    message: "Mensaje de prueba E2E con al menos diez caracteres de contenido.",
  });

  const token = await apiLoginAs("COMMUNICATIONS");
  const inbox = await api.get<{ data: Array<{ id: string; isRead: boolean }> }>(
    "/contact-messages?limit=50",
    token
  );
  expect(inbox.data.find((m) => m.id === submitted.data.id)?.isRead).toBe(false);

  await api.patch(`/contact-messages/${submitted.data.id}/read`, {}, token);
  const inboxAfter = await api.get<{ data: Array<{ id: string; isRead: boolean }> }>(
    "/contact-messages?limit=50",
    token
  );
  expect(inboxAfter.data.find((m) => m.id === submitted.data.id)?.isRead).toBe(true);
});

test("COMMUNICATIONS: read-only access to clubs, athletes, competitions, and documents @tier0", async () => {
  const { clubs, athletes } = loadFixtures();
  const token = await apiLoginAs("COMMUNICATIONS");

  await expect(api.get(`/clubs?limit=10`, token)).resolves.toBeDefined();
  await expect(api.get(`/clubs/${clubs.club1}`, token)).resolves.toBeDefined();
  await expect(api.get(`/athletes/${athletes.club1}`, token)).resolves.toBeDefined();
  await expect(api.get(`/competitions/competition-dates`, token)).resolves.toBeDefined();
  await expect(api.get(`/competitions/championships`, token)).resolves.toBeDefined();
  await expect(api.get(`/competitions/programs`, token)).resolves.toBeDefined();
  await expect(api.get(`/documents`, token)).resolves.toBeDefined();
});

test("COMMUNICATIONS: unrestricted use of the ad-hoc handicap calculator @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  const res = await api.post<{ success: boolean }>(
    "/competitions/tools/calculate-adhoc-handicap",
    {
      crews: [
        {
          id: "crew-1",
          clubAbbreviation: "CNR",
          lane: "1",
          resultCode: "FINISHED",
          time: "4:00.00",
          rowers: [{ fullName: "Test Athlete", birthdate: "1976-01-01" }],
        },
      ],
    },
    token
  );
  expect(res.success).toBe(true);
});

test("COMMUNICATIONS cannot create a club @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.post("/clubs", {}, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("COMMUNICATIONS cannot create an athlete @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.post("/athletes", {}, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("COMMUNICATIONS cannot manage competitions (create a program) @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.post("/competitions/programs", {}, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("COMMUNICATIONS cannot upload institutional documents @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.post("/documents", {}, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("COMMUNICATIONS cannot list users @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.get("/users", token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("COMMUNICATIONS cannot create other users @tier0", async () => {
  const token = await apiLoginAs("COMMUNICATIONS");
  await expect(api.post("/users", {}, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});
