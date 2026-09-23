import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Manual heat editing during IN_REVIEW (see
 * [[fur-seeded-heats-sorteo-plan-pointer]]) — the regatta commission (ADMIN
 * or REGATTA_COMMISSION, confirmed with the user 2026-09-23: both roles,
 * not admin-only) can add a brand-new heat to a prueba, drag a boat into
 * it, and confirm — on top of the algorithm's own proposal. Scoped to
 * ELIMINATORIAS only, per the user's explicit answer; direct multi-finals
 * blocks are untouched.
 */

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function transition(id: string, status: string, token: string) {
  const actingToken = status === "IN_COMPETITION" ? await apiLoginAs("ADMIN") : token;
  return api.patch(`/competitions/competition-dates/${id}/status`, { status }, actingToken);
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
      documentNumber: `EDIT${label}`,
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

test("manual heat editing: ADMIN adds a heat, drags a boat into it, confirms — persists correctly @tier0", async ({
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
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  // 9 entries, pista maxLanes=6 -> ceil(9/2)=5<=6 -> 2 heats (Serie A/B).
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, fx.club1.athleteId, club1Token);
  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club2Id, fx.club2.athleteId, club2Token);
  const fillerAthletes = await Promise.all(
    Array.from({ length: 7 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  for (const athleteId of fillerAthletes) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }

  await transition(fx.competitionDateId, "IN_REVIEW", regattaToken);

  // Serie A (5) + Serie B (4) + a newly-added, empty Serie C (6 lanes) is
  // taller than the default 720px viewport — a tall viewport keeps the
  // drop target on-screen without needing an in-flight scroll, which risks
  // being read by Radix's Sheet as an outside interaction and dismissing
  // it mid-drag.
  await page.setViewportSize({ width: 1280, height: 1800 });

  await loginAs(page, "ADMIN");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorte/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  await page.getByRole("button", { name: "Agregar serie" }).first().click();
  await expect(page.getByText("SERIE C")).toBeVisible();

  // Drag the first occupied card (Serie A, lane 1) into Serie C's first
  // empty lane — dnd-kit's PointerSensor needs real pointer events, not
  // HTML5 drag/drop, so this simulates the actual mouse sequence.
  const sourceCard = page.locator(".cursor-grab").first();
  const targetSlot = page.locator('text="—"').first();
  const sourceBox = await sourceCard.boundingBox();
  const targetBox = await targetSlot.boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();

  const sx = sourceBox!.x + sourceBox!.width / 2;
  const sy = sourceBox!.y + sourceBox!.height / 2;
  const tx = targetBox!.x + targetBox!.width / 2;
  const ty = targetBox!.y + targetBox!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Fail fast, with a clear signal, if the drag itself didn't move
  // anything — rather than only finding out via the API assertion at the
  // end of the test. A plain move within the same prueba (occupied lane ->
  // empty lane) leaves the TOTAL "—" placeholder count unchanged (one
  // empties out, one fills in), so that count can't be used as the signal
  // — dnd-kit's own accessibility announcement, naming the exact source
  // and target slot IDs, is the reliable one.
  await expect(page.getByRole("status")).toContainText(`${fx.eventId3}~~A~~1`);
  await expect(page.getByRole("status")).toContainText(`${fx.eventId3}~~C~~1`);

  await page.getByRole("button", { name: "Confirmar prueba" }).first().click();
  await expect(page.getByText("Prueba confirmada")).toBeVisible();

  // Verify persistence via the real API — some crew entry for this event is
  // now in series "C", lane 1.
  const entries = await api.get<{
    data: { id: string; eventId: string; series: string | null; lane: number | null }[];
  }>(
    `/competitions/crew-entries?competitionDateId=${fx.competitionDateId}&clubId=${fx.club1Id}`,
    club1Token
  );
  const inSerieC = entries.data.filter((e) => e.eventId === fx.eventId3 && e.series === "C");
  expect(inSerieC.length).toBeGreaterThan(0);
  expect(inSerieC[0]!.lane).toBe(1);
});

test("manual heat editing: removing an empty heat makes it disappear @tier0", async ({ page }) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const { credentials } = loadFixtures();
  const fx = await setupInscriptionFixtures(regattaToken, {
    extraEventHasHeats: true,
    dateOverrides: { refereePresidentId: credentials.REFEREE.userId },
  });
  const adminToken = await apiLoginAs("ADMIN");
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, fx.club1.athleteId, club1Token);
  const fillerAthletes = await Promise.all(
    Array.from({ length: 6 }, () => extraAthlete(adminToken, fx.club1Id))
  );
  for (const athleteId of fillerAthletes) {
    await inscribe(fx.competitionDateId, fx.eventId3!, fx.club1Id, athleteId, club1Token);
  }

  await transition(fx.competitionDateId, "IN_REVIEW", regattaToken);

  await loginAs(page, "REGATTA_COMMISSION");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/review`);
  await page.getByRole("button", { name: /sorte/i }).first().click();
  await expect(page.getByText("Propuesta de sorteo")).toBeVisible();

  await page.getByRole("button", { name: "Agregar serie" }).first().click();
  await expect(page.getByText("SERIE C")).toBeVisible();

  await page.getByRole("button", { name: /Eliminar/i }).first().click();
  await expect(page.getByText("SERIE C")).not.toBeVisible();
});

test("sorteo confirm rejects two boats claiming the same lane in the same heat @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const club2Token = await loginApi(fx.club2.delegateEmail, fx.club2.delegatePassword);

  const entry1 = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );
  const entry2 = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club2Id,
    fx.club2.athleteId,
    club2Token
  );

  await expect(
    api.post(
      `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
      {
        assignments: [
          { entryId: entry1.data.id, series: "A", lane: 1 },
          { entryId: entry2.data.id, series: "A", lane: 1 },
        ],
      },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("sorteo confirm rejects a lane outside the pista's maxLanes @tier0", async () => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken); // default fixture pista maxLanes: 6
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const entry = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );

  await expect(
    api.post(
      `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
      { assignments: [{ entryId: entry.data.id, series: "A", lane: 99 }] },
      regattaToken
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});
