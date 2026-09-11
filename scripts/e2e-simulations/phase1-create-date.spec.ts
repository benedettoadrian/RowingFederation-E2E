import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SIM_PASSWORD, SIM_REGATTA_COMMISSION_EMAIL, SIMULATION_DATE } from "./config.js";
import { simLogin, readState, writeState } from "./lib/ui.js";

/**
 * Fase 1 of plan.md — creates the brand-new competition date the whole
 * simulation runs against, cloning Fecha 3's config (organizing club,
 * pista, program, horarios), then walks it DRAFT -> PUBLISHED ->
 * INSCRIPTION_OPEN. Logged in as the REGATTA_COMMISSION test user created in
 * Fase 2 (has "competitions:manage" permission, same as ADMIN).
 *
 * Single test() so one video (playwright.config.ts `video: "on"`) captures
 * the whole fase end to end instead of splitting across separate clips.
 *
 * Skips creation if `output/simulation-state.json` already has a
 * competitionDateId (practical idempotency for iterating on later phases
 * without piling up throwaway dates every re-run during development — D2's
 * "each real run gets a fresh date" still holds for a from-scratch run,
 * since a from-scratch run has no prior state file).
 */
const recipe = JSON.parse(
  readFileSync(new URL("./output/recipe.json", import.meta.url), "utf8")
);

function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toDatetimeLocalInput(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/** Clicks a status-transition button and confirms the AlertDialog it opens (CompetitionDateActions.tsx). */
async function transitionStatus(page: Page, buttonLabel: string) {
  await page.getByRole("button", { name: buttonLabel, exact: true }).click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
}

test("Fase 1 — crear fecha de competencia nueva y abrir inscripciones", async ({ page }) => {
  const existing = readState();
  let competitionDateId = existing.competitionDateId;

  await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);

  if (competitionDateId) {
    console.log(`Reusing existing simulation competition date: ${competitionDateId}`);
  } else {
    const runTag = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `E2E-SIM ${runTag}`;

    const inscriptionOpenAt = new Date(); // now
    const inscriptionCloseAt = new Date(SIMULATION_DATE.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days before

    await page.goto("/es/competitions/dates/new");

    // Step 1
    await page.getByLabel("Nombre de la fecha").fill(name);
    await page.getByLabel("Club organizador").click();
    await page.getByRole("option", { name: recipe.sourceDate.organizingClubName, exact: true }).click();
    // NOTE (real finding, see plan.md): Fecha 3's persisted pistaId belongs
    // to a DIFFERENT club (Club Remeros Paysandú) than its organizingClubId
    // (Carmelo Rowing Club) — pistas.clubId FK confirms this. The real
    // wizard's pista dropdown is scoped to the organizing club's own pistas
    // only, so that exact historical combination can't be reproduced through
    // this UI. Picking whatever pista the organizing club actually offers
    // instead (there's exactly one per club in this dataset).
    await page.getByLabel("Pista de remo").click();
    const pistaOption = page.getByRole("option").first();
    const pistaName = (await pistaOption.innerText()).trim();
    await pistaOption.click();
    await page.getByLabel("Fecha de la competencia").fill(toDateInput(SIMULATION_DATE));
    await page.getByRole("button", { name: "Siguiente" }).click();

    // Step 2
    await page.getByLabel("Apertura de inscripciones").fill(toDatetimeLocalInput(inscriptionOpenAt));
    await page.getByLabel("Cierre de inscripciones").fill(toDatetimeLocalInput(inscriptionCloseAt));
    await page.getByLabel("Hora de inicio").fill(recipe.sourceDate.startTime);
    await page.getByLabel("Min. entre eliminatorias").fill(String(recipe.sourceDate.minutesBetweenHeats));
    await page.getByLabel("Min. entre finales").fill(String(recipe.sourceDate.minutesBetweenFinals));
    await page.getByRole("button", { name: "Siguiente" }).click();

    // Step 3 — programa clonado de Fecha 3; handicap/referí/ventana de cambios
    // se dejan sin definir acá (referí presidente + ventana se asignan en
    // Fase 5.2, junto con el resto del cierre de inscripciones/revisión).
    await page.getByLabel("Programa").click();
    await page.getByRole("option", { name: recipe.sourceDate.programName, exact: true }).click();
    await page.getByRole("button", { name: "Crear fecha" }).click();

    // Excludes "new" so this actually waits for the post-submit navigation
    // instead of trivially matching the wizard's own URL we're already on.
    await page.waitForURL(/\/es\/competitions\/dates\/(?!new$)[^/]+$/, { timeout: 15_000 });
    competitionDateId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(name);

    console.log(`Created competition date ${competitionDateId} (${name}), pista: ${pistaName}`);
    writeState({ competitionDateId, competitionDateName: name });
  }

  await page.goto(`/es/competitions/dates/${competitionDateId}`);

  // The action buttons render only after the date's data finishes loading
  // client-side — wait for one of the possible action/status buttons
  // instead of checking counts immediately after goto (which races the
  // fetch and always reads 0).
  await page
    .getByRole("button", { name: /Publicar|Abrir inscripciones|Cerrar inscripciones/ })
    .first()
    .waitFor({ timeout: 10_000 });

  const currentlyDraft = (await page.getByRole("button", { name: "Publicar" }).count()) > 0;
  const currentlyPublished = (await page.getByRole("button", { name: "Abrir inscripciones" }).count()) > 0;

  if (currentlyDraft) {
    await transitionStatus(page, "Publicar");
    await expect(page.getByRole("button", { name: "Abrir inscripciones" })).toBeVisible({ timeout: 10_000 });
  }
  if (currentlyDraft || currentlyPublished) {
    await transitionStatus(page, "Abrir inscripciones");
    await expect(page.getByRole("button", { name: "Cerrar inscripciones" })).toBeVisible({ timeout: 10_000 });
  }
  console.log(`Competition date ${competitionDateId} is now INSCRIPTION_OPEN (or already was).`);
});
