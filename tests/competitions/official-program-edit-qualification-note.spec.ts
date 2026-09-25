import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Regression (2026-09-24): the "Programa Oficial" page
 * (/competitions/dates/[id]/program) lets an ADMIN open a prueba's pencil
 * icon (onEditEvent in ProgramView -> EditEventCrewDialog) while the date is
 * CLOSED/IN_COMPETITION (ADMIN_EDIT_STATUSES, program/page.tsx). That dialog
 * now also edits the prueba's qualification note (QualificationNoteField,
 * variant="card", always canEdit inside this dialog) — the same free-text
 * field already covered for the REGATTA_COMMISSION sorteo-proposal entry
 * point in sorteo-qualification-note.spec.ts, but reached through this
 * different entry point, which had no coverage of its own.
 */

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function inscribe(
  competitionDateId: string,
  eventId: string,
  clubId: string,
  athleteId: string,
  token: string
) {
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    { competitionDateId, eventId, clubId, members: [{ athleteId, role: "ROWER" }] },
    token
  );
}

test("ADMIN edits a prueba's qualification note from the official program page's pencil/EditEventCrewDialog, it persists across reload, and shows read-only under the prueba @tier0", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const inscribed = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );

  // Same CLOSED-transition sequence as official-program-page-access.spec.ts
  // (IN_REVIEW -> sorteo/confirm -> referee/crew-change-window fields ->
  // CLOSED), except the assignment uses a heat series ("Heat 1", not
  // "Final") so the prueba renders as an eliminatoria block: the read-only
  // QualificationNoteField shown directly under a prueba (ProgramView.tsx,
  // isLastSeriesOfEvent block) only renders for eliminatorias, never for a
  // direct final.
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: inscribed.data.id, series: "Heat 1", lane: 1 }] },
    regattaToken
  );
  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/program`);

  // The heat block's pencil (title="Editar inscripciones de esta prueba",
  // programView.editEntriesTooltip). Eliminatorias render before finales in
  // ProgramView, and this event's final hasn't been drawn yet (still a
  // pending-final placeholder that carries the same pencil/tooltip) — so
  // `.first()` deterministically lands on the confirmed heat block, not the
  // empty pending final.
  const editPencil = page.getByTitle("Editar inscripciones de esta prueba").first();
  await editPencil.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Editar prueba")).toBeVisible();

  const noteField = page.getByLabel("Clasificación a la final");
  await expect(noteField).toBeVisible();
  await expect(noteField).toBeEditable();

  const noteText = "Clasifican los 2 primeros de la serie a la final.";
  await noteField.fill(noteText);
  await noteField.blur();
  await expect(page.getByText("Nota de clasificación guardada")).toBeVisible();

  // Close, hard reload, reopen — a hard reload forces a real refetch from
  // the backend instead of relying on the mutation's own client-side cache
  // invalidation to prove persistence.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();

  await page.getByTitle("Editar inscripciones de esta prueba").first().click();
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Clasificación a la final")).toHaveValue(noteText);

  // Same note, read-only, directly under the prueba block outside the
  // dialog — qualificationNoteByEventId feeds both places from the same
  // useQualificationNotes query.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(noteText)).toBeVisible();

  // And confirm the write actually landed on the backend record, not just
  // in the client cache.
  const persisted = await api.get<{ data: { eventId: string; text: string }[] }>(
    `/competitions/qualification-notes/${fx.competitionDateId}`,
    regattaToken
  );
  expect(persisted.data).toEqual([
    expect.objectContaining({ eventId: fx.eventId, text: noteText }),
  ]);
});
