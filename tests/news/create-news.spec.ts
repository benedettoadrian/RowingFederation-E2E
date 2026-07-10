import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 6.1 — news creation. Role guard is requiresNewsManage(), NOT just
 * "director roles" as the task wording implied — verified against source:
 * [ADMIN, FEDERATION_ADMIN, ...DIRECTOR_ROLES] where DIRECTOR_ROLES =
 * PRESIDENT/VICE_PRESIDENT/GENERAL_SECRETARY/TREASURER/MINUTES_SECRETARY/
 * DELEGATE. REGATTA_COMMISSION/REFEREE/CLUB_DELEGATE are excluded.
 * Created news always starts isPublished:false — publish is a separate
 * PATCH .../publish call, same role guard.
 */

function newsPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: `Noticia E2E ${randomUUID().slice(0, 8)}`,
    excerpt: "Resumen corto de la noticia para pruebas E2E.",
    content: "Contenido completo de la noticia de prueba, con al menos diez caracteres.",
    ...overrides,
  };
}

test("golden path: DELEGATE (director role) creates a news article as unpublished @tier0", async () => {
  const token = await apiLoginAs("DELEGATE");
  const created = await api.post<{ data: { id: string; isPublished: boolean } }>(
    "/news",
    newsPayload(),
    token
  );
  expect(created.data.isPublished).toBe(false);
});

test("publish then unpublish toggles visibility on the public endpoint @tier0", async () => {
  const token = await apiLoginAs("DELEGATE");
  const created = await api.post<{ data: { id: string } }>("/news", newsPayload(), token);
  const id = created.data.id;

  await api.patch(`/news/${id}/publish`, {}, token);
  const publicList = await api.get<{ data: Array<{ id: string }> }>("/news");
  expect(publicList.data.some((n) => n.id === id)).toBe(true);

  await api.patch(`/news/${id}/unpublish`, {}, token);
  const publicListAfter = await api.get<{ data: Array<{ id: string }> }>("/news");
  expect(publicListAfter.data.some((n) => n.id === id)).toBe(false);
});

test("CLUB_DELEGATE cannot create news @tier0", async () => {
  const token = await apiLoginAs("CLUB_DELEGATE");
  await expect(api.post("/news", newsPayload(), token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("REGATTA_COMMISSION cannot create news @tier0", async () => {
  const token = await apiLoginAs("REGATTA_COMMISSION");
  await expect(api.post("/news", newsPayload(), token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("rejects an excerpt shorter than 10 characters @tier0", async () => {
  const token = await apiLoginAs("DELEGATE");
  await expect(
    api.post("/news", newsPayload({ excerpt: "short" }), token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
