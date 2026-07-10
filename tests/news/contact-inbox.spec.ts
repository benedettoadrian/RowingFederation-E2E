import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Fase 8.3 — public contact form -> admin inbox -> mark as read.
 * POST /public/contact is unauthenticated. The inbox
 * (GET/PATCH /contact-messages) is guarded by requiresNewsManage() — same
 * role group as news creation (Fase 6.1): ADMIN/FEDERATION_ADMIN/director
 * roles, NOT REGATTA_COMMISSION/REFEREE/CLUB_DELEGATE.
 */

function contactPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "E2E Test Contact",
    email: `contact-${randomUUID().slice(0, 8)}@e2e.test`,
    subject: `Consulta E2E ${randomUUID().slice(0, 8)}`,
    message: "Mensaje de prueba E2E con al menos diez caracteres de contenido.",
    ...overrides,
  };
}

test("golden path: public submits a contact message, it appears unread in the admin inbox @tier0", async () => {
  const payload = contactPayload();
  const submitted = await api.post<{ data: { id: string } }>("/public/contact", payload);

  const token = await apiLoginAs("DELEGATE");
  const inbox = await api.get<{ data: Array<{ id: string; isRead: boolean; subject: string }> }>(
    "/contact-messages?limit=50",
    token
  );
  const entry = inbox.data.find((m) => m.id === submitted.data.id);
  expect(entry?.isRead).toBe(false);
  expect(entry?.subject).toBe(payload.subject);
});

test("marking a message as read updates isRead and is idempotent @tier0", async () => {
  const submitted = await api.post<{ data: { id: string } }>("/public/contact", contactPayload());
  const token = await apiLoginAs("DELEGATE");

  await api.patch(`/contact-messages/${submitted.data.id}/read`, {}, token);
  let inbox = await api.get<{ data: Array<{ id: string; isRead: boolean }> }>(
    "/contact-messages?limit=50",
    token
  );
  expect(inbox.data.find((m) => m.id === submitted.data.id)?.isRead).toBe(true);

  // Idempotent — marking an already-read message again should not error.
  await api.patch(`/contact-messages/${submitted.data.id}/read`, {}, token);
  inbox = await api.get<{ data: Array<{ id: string; isRead: boolean }> }>(
    "/contact-messages?limit=50",
    token
  );
  expect(inbox.data.find((m) => m.id === submitted.data.id)?.isRead).toBe(true);
});

test("CLUB_DELEGATE cannot access the contact inbox @tier0", async () => {
  const token = await apiLoginAs("CLUB_DELEGATE");
  await expect(api.get("/contact-messages?limit=50", token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("rejects a contact message with a message shorter than 10 characters @tier0", async () => {
  await expect(
    api.post("/public/contact", contactPayload({ message: "short" }))
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
