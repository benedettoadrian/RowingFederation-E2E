import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SIM_PASSWORD, SIM_REGATTA_COMMISSION_EMAIL } from "./config.js";
import { simLogin, readState, writeState } from "./lib/ui.js";
import { withLocalDb } from "./lib/db.js";

/**
 * Fase 5 of plan.md — full scope in one test/one video, with the CORRECTED
 * order found the hard way in a previous run (see plan.md): each club must
 * confirm/lock its inscriptions (generating its verificationCode) WHILE the
 * date is still INSCRIPTION_OPEN — confirm-inscriptions.use-case.ts rejects
 * outside that status, and CompetitionDateStatus has no transition back to
 * it once closed. Order here: 5.3 prep (confirm each club) -> 5.3 (regatta
 * commission views the codes) -> 5.1 (close inscriptions) -> 5.2 (referee +
 * crew-change window) -> 5.4 (sorteo) -> 5.5 (close review + public page).
 */
interface Recipe {
  clubs: { clubId: string; clubName: string }[];
}
const recipe: Recipe = JSON.parse(
  readFileSync(new URL("./output/recipe.json", import.meta.url), "utf8")
);

async function getVerificationCode(competitionDateId: string, clubId: string): Promise<string | null> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      `SELECT "verificationCode" FROM club_date_submissions WHERE "competitionDateId"=$1 AND "clubId"=$2`,
      [competitionDateId, clubId]
    );
    return res.rows[0]?.verificationCode ?? null;
  });
}

test("Fase 5 — confirmación de inscripciones, cierre, sorteo y revisión", async ({ page }) => {
  const state = readState();
  if (!state.competitionDateId) throw new Error("Run phase1-create-date first.");
  const competitionDateId = state.competitionDateId;

  const codesByClubId: Record<string, string> = { ...state.submissionCodesByClubId };

  await test.step("Fase 5.3 prep — confirmar inscripciones de cada club (genera el código)", async () => {
    if (!state.delegatesByClubId) throw new Error("Run phase2-create-users first.");

    for (const [clubId, delegate] of Object.entries(state.delegatesByClubId)) {
      const club = recipe.clubs.find((c) => c.clubId === clubId);
      const clubName = club?.clubName ?? clubId;

      const existingCode = await getVerificationCode(competitionDateId, clubId);
      if (existingCode) {
        console.log(`  ${clubName}: already confirmed, code ${existingCode}`);
        codesByClubId[clubId] = existingCode;
        continue;
      }

      await simLogin(page, delegate.email, SIM_PASSWORD);
      await page.goto(`/es/competitions/dates/${competitionDateId}/inscriptions`);

      // NOTE: use .waitFor(), not .isVisible({timeout}) — the latter doesn't
      // poll (see Fase 4's root-cause finding), it would false-positive as
      // "already locked" before the banner even finishes loading.
      const finalizeButton = page.getByRole("button", { name: "Finalizar inscripción" });
      const alreadyLocked = !(await finalizeButton
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false));
      if (alreadyLocked) {
        const code = await getVerificationCode(competitionDateId, clubId);
        console.log(`  ${clubName}: banner shows locked but no code found in DB yet (${code})`);
        if (code) codesByClubId[clubId] = code;
        continue;
      }

      await finalizeButton.click();
      await page.getByRole("button", { name: "Confirmar inscripciones", exact: true }).click();
      await expect(page.getByText("Código de verificación", { exact: false })).toBeVisible({ timeout: 10_000 });

      const code = await getVerificationCode(competitionDateId, clubId);
      console.log(`  ${clubName}: confirmed, code ${code}`);
      if (code) codesByClubId[clubId] = code;
    }

    writeState({ submissionCodesByClubId: codesByClubId });
    console.log(`Fase 5.3 prep done. ${Object.keys(codesByClubId).length} club(s) with a code on record.`);
  });

  await test.step("Fase 5.3 — comisión de regatas ve los códigos de verificación por club", async () => {
    await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}`);
    await expect(page.getByText("Verificación de inscripciones por club")).toBeVisible({ timeout: 10_000 });

    let matched = 0;
    for (const [clubId, code] of Object.entries(codesByClubId)) {
      const club = recipe.clubs.find((c) => c.clubId === clubId);
      const visible = await page.getByText(code).first().isVisible().catch(() => false);
      if (visible) matched += 1;
      else console.log(`  ⚠️  code for ${club?.clubName ?? clubId} not visible on the verification screen`);
    }
    console.log(`Fase 5.3: ${matched}/${Object.keys(codesByClubId).length} club codes visible to the regatta commission.`);
  });

  await test.step("Fase 5.1 — cerrar inscripciones (INSCRIPTION_OPEN -> IN_REVIEW)", async () => {
    await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}`);

    const currentlyOpen = await page
      .getByRole("button", { name: "Cerrar inscripciones" })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    const alreadyInReview = await page
      .getByRole("button", { name: "Cerrar fecha" })
      .isVisible({ timeout: 500 })
      .catch(() => false);

    if (!currentlyOpen && !alreadyInReview) {
      // Data hasn't loaded yet — wait properly before deciding (same class of
      // bug as the Fase 4 root cause: isVisible() alone doesn't poll).
      await page
        .getByRole("button", { name: /Cerrar inscripciones|Cerrar fecha/ })
        .waitFor({ state: "visible", timeout: 10_000 });
    }

    const stillOpen = await page.getByRole("button", { name: "Cerrar inscripciones" }).isVisible();
    if (stillOpen) {
      await page.getByRole("button", { name: "Cerrar inscripciones", exact: true }).click();
      await page.getByRole("button", { name: "Confirmar", exact: true }).click();
      await page.getByRole("button", { name: "Cerrar fecha" }).waitFor({ state: "visible", timeout: 10_000 });
      console.log("Transitioned to IN_REVIEW.");
    } else {
      console.log("Already past INSCRIPTION_OPEN — no transition needed.");
    }
  });

  await test.step("Fase 5.2 — asignar referí presidente y ventana de cambios de tripulación", async () => {
    await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}/edit`);

    await page.getByLabel("Árbitro presidente").click();
    // Real bug found (2026-09-10): a bare /E2E-SIM Referee/ regex matched
    // BOTH "E2E-SIM Referee" and "E2E-SIM Referee Dos" (the second referee
    // added this session for the results-loading role split) — never
    // ambiguous before that second user existed. Exact match picks the
    // actual president, not whichever sorts first.
    await page.getByRole("option", { name: "E2E-SIM Referee", exact: true }).click();

    // Crew-change window: open now, closes a day before the competition (2026-11-07).
    await page.getByLabel("Apertura de cambios de tripulación").fill("2026-10-15T00:00");
    await page.getByLabel("Cierre de cambios de tripulación").fill("2026-11-06T00:00");

    await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await page.waitForURL(/\/competitions\/dates\/[^/]+$/, { timeout: 10_000 });

    await expect(page.getByText("E2E-SIM Referee", { exact: true })).toBeVisible({ timeout: 10_000 });
    console.log("Referee president + crew-change window set.");
  });

  await test.step("Fase 5.4 — generar y confirmar el sorteo", async () => {
    await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}/review`);

    const alreadyConfirmed = await page.getByText("Sorteo confirmado", { exact: false }).isVisible({ timeout: 2_000 }).catch(() => false);
    if (alreadyConfirmed) {
      console.log("Sorteo already confirmed — skipping.");
      return;
    }

    await page.getByRole("button", { name: /Generar sorteo|Re-sortear/ }).click();
    await page.getByRole("button", { name: "Confirmar sorteo", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "Confirmar sorteo", exact: true }).click();
    await page.waitForTimeout(3_000);
    console.log("Sorteo confirmed.");
  });

  await test.step("Fase 5.5 — cerrar revisión (IN_REVIEW -> CLOSED) y validar página pública", async () => {
    await simLogin(page, SIM_REGATTA_COMMISSION_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}/review`);

    const closeButton = page.getByRole("button", { name: "Cerrar revisión" });
    await closeButton.waitFor({ state: "visible", timeout: 10_000 });
    await closeButton.click();
    // The dialog's confirm action shares the exact same label as the trigger
    // button — scope to the dialog to avoid a strict-mode ambiguity.
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cerrar revisión", exact: true })
      .click();
    await page.waitForURL(/\/competitions\/dates\/[^/]+$/, { timeout: 10_000 });
    console.log("Transitioned to CLOSED.");

    // Public page, no login — clear cookies on the SAME page/context instead
    // of opening a new one (video: "on" records a separate file per new
    // page, which would split this fase's video in two). Clearing cookies
    // proves the page truly needs no auth just as well as a fresh context.
    await page.context().clearCookies();
    await page.goto(`/es/calendario/${competitionDateId}`);
    // Investigated a real false negative here (2026-09-10): the "E2E-SIM"
    // header text is server-rendered and appears fast, but the actual
    // program table is a separate client-side fetch that resolves later —
    // reading body text right after the header check caught it mid-load and
    // logged a false "program not showing" even though it renders correctly
    // moments later (confirmed manually). Wait for an actual event code
    // instead of the header text.
    await page.getByText(/\[\dx\]/).first().waitFor({ state: "visible", timeout: 15_000 });
    const bodyText = await page.locator("body").innerText();
    console.log("Public page shows program:", bodyText.includes("[1x]") || bodyText.includes("[2x]"));
  });

  await test.step("Fase 5.6 — auditoría: sin fallas inesperadas en audit_logs durante esta fase", async () => {
    const unexpected = await withLocalDb(async (db) => {
      const res = await db.query(
        `SELECT "actionType", "entityType", "errorMessage", timestamp FROM audit_logs
         WHERE success = false AND timestamp >= now() - interval '10 minutes'
         ORDER BY timestamp`
      );
      return res.rows;
    });
    if (unexpected.length > 0) {
      console.log(`  ⚠️  ${unexpected.length} audit_logs row(s) with success=false in the last 10 min:`);
      for (const row of unexpected) console.log(`    ${row.timestamp} ${row.actionType} ${row.entityType}: ${row.errorMessage}`);
    } else {
      console.log("  No unexpected success=false audit_logs rows this fase.");
    }
  });
});
