import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Free-text, optional, per-(competitionDate,event) note explaining how
 * qualification from heats to the final proceeds — shown under every
 * eliminatoria block, both in the sorteo proposal and the confirmed
 * official program. Federation directive 2026-09-24, following up on the
 * discovery that the auto-draw's "top N by heat position" rule doesn't
 * always match "best time across all heats" for uneven heat splits — see
 * [[fur-heat-qualification-note-plan]].
 */

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function extraAthlete(adminToken: string, clubId: string) {
  const label = randomUUID().slice(0, 8).toUpperCase();
  const created = await api.post<{ data: { id: string } }>(
    "/athletes",
    {
      firstName: "Extra",
      firstSurname: label,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `QN${label}`,
      currentClubId: clubId,
      status: "ACTIVE",
    },
    adminToken
  );
  return created.data.id;
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

test("REGATTA_COMMISSION writes a qualification note under an eliminatoria, it persists across reload, and clearing it removes it @tier0", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    extraEventHasHeats: true,
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  // pista maxLanes=6 — 7 boats in the hasHeats event forces 2 real heat
  // series instead of a single direct final. Nothing inscribed in the
  // other two (hasHeats: false) events, so this is the only eliminatoria
  // block — no locator ambiguity for the note field.
  const athleteIds = await Promise.all(
    Array.from({ length: 7 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  for (const athleteId of athleteIds) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  await loginAs(page, "REGATTA_COMMISSION");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorteo/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  const noteField = page.getByLabel("Clasificación a la final");
  await expect(noteField).toBeVisible();
  await noteField.fill("Clasifican los 4 mejores tiempos entre ambas series.");
  await noteField.blur();
  await expect(page.getByText("Nota de clasificación guardada")).toBeVisible();

  const afterSave = await api.get<{ data: { eventId: string; text: string }[] }>(
    `/competitions/qualification-notes/${fx.competitionDateId}`,
    adminToken
  );
  expect(afterSave.data).toEqual([
    expect.objectContaining({
      eventId: fx.eventId3,
      text: "Clasifican los 4 mejores tiempos entre ambas series.",
    }),
  ]);

  // Persists across a hard reload — reopen the sheet and the field shows
  // the saved text, not the empty placeholder.
  await page.reload();
  await page.getByRole("button", { name: /sorteo/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();
  await expect(page.getByLabel("Clasificación a la final")).toHaveValue(
    "Clasifican los 4 mejores tiempos entre ambas series."
  );

  // Clearing it back to blank deletes the row instead of storing "".
  await page.getByLabel("Clasificación a la final").fill("");
  await page.getByLabel("Clasificación a la final").blur();
  await expect(page.getByText("Nota de clasificación guardada")).toBeVisible();

  const afterClear = await api.get<{ data: unknown[] }>(
    `/competitions/qualification-notes/${fx.competitionDateId}`,
    adminToken
  );
  expect(afterClear.data).toEqual([]);
});

test("qualification note locks to read-only once the prueba's sorteo is confirmed @tier0", async ({
  page,
}) => {
  const adminToken = await apiLoginAs("ADMIN");
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    extraEventHasHeats: true,
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const athleteIds = await Promise.all(
    Array.from({ length: 7 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  for (const athleteId of athleteIds) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );

  await loginAs(page, "REGATTA_COMMISSION");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorteo/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  await page.getByLabel("Clasificación a la final").fill("Clasifican los 4 mejores tiempos.");
  await page.getByLabel("Clasificación a la final").blur();
  await expect(page.getByText("Nota de clasificación guardada")).toBeVisible();

  // Still editable before confirming — the lock only applies once this
  // specific prueba's series/lanes are actually confirmed.
  await expect(page.getByLabel("Clasificación a la final")).toBeEditable();

  await page.getByRole("button", { name: "Confirmar prueba" }).first().click();
  await expect(page.getByText("Prueba confirmada")).toBeVisible();

  // Locked immediately, still inside the sheet: plain text, no textbox.
  await expect(page.getByLabel("Clasificación a la final")).not.toBeVisible();
  await expect(page.getByText("Clasifican los 4 mejores tiempos.")).toBeVisible();

  // Still locked after reload, now viewed through the confirmed official
  // program view (review page switches away from the sheet once every
  // entry has a real series).
  await page.reload();
  await expect(page.getByText("Clasifican los 4 mejores tiempos.")).toBeVisible();
  await expect(page.getByLabel("Clasificación a la final")).not.toBeVisible();

  // The lock is UI-only, not a backend restriction — regatta staff can
  // still fix a typo via the API if truly needed. Confirms this isn't a
  // permission regression, just a "protect the confirmed record by
  // default" UI choice.
  await expect(
    api.put(
      `/competitions/qualification-notes/${fx.competitionDateId}/${fx.eventId3}`,
      { text: "Corregido a mano vía API" },
      regattaToken
    )
  ).resolves.toBeDefined();
});

test("qualification note write rejects a CLUB_DELEGATE — same REGATTA_MANAGERS guard as the sorteo endpoints @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await expect(
    api.put(
      `/competitions/qualification-notes/${fx.competitionDateId}/${fx.eventId}`,
      { text: "Intento no autorizado" },
      club1Token
    )
  ).rejects.toMatchObject({ status: 403 });

  // Read stays open to any authenticated role, though.
  const read = await api.get<{ data: unknown[] }>(
    `/competitions/qualification-notes/${fx.competitionDateId}`,
    club1Token
  );
  expect(read.data).toEqual([]);
});
