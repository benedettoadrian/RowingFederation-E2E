import { test, expect } from "@playwright/test";
import { SIM_PASSWORD } from "./config.js";
import { SIM_BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { simLogin, readState } from "./lib/ui.js";
import { withLocalDb } from "./lib/db.js";
import { SOURCE_COMPETITION_DATE_ID } from "./config.js";

/**
 * Fase 7 of plan.md — full scope in one test/one video: finalize the date
 * (7.1), compare the new date against Fecha 3 (7.2), and a final audit pass
 * (7.3). 7.4 (written findings report) is not a UI/DB check — it's produced
 * separately as a plan.md write-up once this run's real numbers are known.
 */
test("Fase 7 — finalizar fecha y comparación final contra Fecha 3", async ({ page }) => {
  const state = readState();
  if (!state.competitionDateId) throw new Error("Run phase1-create-date first.");
  const newDateId = state.competitionDateId;

  await test.step("Fase 7.1 — Finalizar fecha (IN_COMPETITION -> FINAL_RESULTS)", async () => {
    await simLogin(page, SIM_BOOTSTRAP_ADMIN_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${newDateId}/results`);

    const alreadyFinal = await page.getByText("FINAL_RESULTS", { exact: false }).isVisible({ timeout: 1_000 }).catch(() => false);
    const finalizeButton = page.getByRole("button", { name: "Finalizar fecha" });
    const found = await finalizeButton.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);

    if (!found && !alreadyFinal) {
      throw new Error("Finalizar fecha button not found and date isn't already FINAL_RESULTS — is Fase 6.3 fully confirmed?");
    }
    if (found) {
      await finalizeButton.click();
      // The dialog's confirm action shares the exact same label as the
      // trigger button ("Finalizar fecha") — scope to the dialog to avoid a
      // strict-mode ambiguity (same pattern as Fase 5.5's "Cerrar revisión").
      await page.getByRole("alertdialog").getByRole("button", { name: "Finalizar fecha", exact: true }).click();
      await page.waitForTimeout(2_000);
    }

    const status = await withLocalDb(async (db) => {
      const res = await db.query(`SELECT status FROM competition_dates WHERE id = $1`, [newDateId]);
      return res.rows[0]?.status;
    });
    expect(status).toBe("FINAL_RESULTS");
    console.log(`Fecha ${newDateId} is now FINAL_RESULTS.`);
  });

  await test.step("Fase 7.2 — comparación contra Fecha 3", async () => {
    const comparison = await withLocalDb(async (db) => {
      async function counts(competitionDateId: string) {
        const entries = await db.query(`SELECT count(*) FROM crew_entries WHERE "competitionDateId" = $1`, [competitionDateId]);
        const events = await db.query(
          `SELECT count(DISTINCT "eventId") FROM crew_entries WHERE "competitionDateId" = $1`,
          [competitionDateId]
        );
        const results = await db.query(
          `SELECT count(*) FROM crew_entry_results r JOIN crew_entries ce ON ce.id = r."crewEntryId" WHERE ce."competitionDateId" = $1`,
          [competitionDateId]
        );
        const confirmed = await db.query(
          `SELECT count(*) FROM crew_entry_results r JOIN crew_entries ce ON ce.id = r."crewEntryId" WHERE ce."competitionDateId" = $1 AND r."confirmedAt" IS NOT NULL`,
          [competitionDateId]
        );
        return {
          entries: Number(entries.rows[0].count),
          events: Number(events.rows[0].count),
          results: Number(results.rows[0].count),
          confirmed: Number(confirmed.rows[0].count),
        };
      }
      return { source: await counts(SOURCE_COMPETITION_DATE_ID), replica: await counts(newDateId) };
    });

    console.log("Fecha 3 (fuente):", comparison.source);
    console.log("Fecha nueva (réplica):", comparison.replica);
    console.log(
      `Diferencia: ${comparison.source.entries - comparison.replica.entries} inscripciones, ` +
        `${comparison.source.events - comparison.replica.events} eventos, ` +
        `${comparison.source.results - comparison.replica.results} resultados ` +
        `(ver plan.md para el detalle documentado de cada salteo real).`
    );

    // Public page still renders correctly once FINAL_RESULTS — no login needed.
    await page.context().clearCookies();
    await page.goto(`/es/calendario/${newDateId}`);
    await page.getByText("E2E-SIM").first().waitFor({ state: "visible", timeout: 10_000 });
    console.log("Public page still renders correctly at FINAL_RESULTS.");
  });

  await test.step("Fase 7.3 — auditoría final", async () => {
    const finalizeLogged = await withLocalDb(async (db) => {
      const res = await db.query(
        `SELECT "actionType", "entityType", success FROM audit_logs
         WHERE "entityId" = $1 AND timestamp >= now() - interval '2 hours'
         ORDER BY timestamp DESC LIMIT 5`,
        [newDateId]
      );
      return res.rows;
    });
    console.log("Últimas entradas de audit_logs para esta fecha:", finalizeLogged);

    const unexpectedTotal = await withLocalDb(async (db) => {
      const res = await db.query(
        `SELECT count(*) FROM audit_logs WHERE success = false AND timestamp >= now() - interval '6 hours'`
      );
      return Number(res.rows[0].count);
    });
    console.log(`Total de audit_logs con success=false en las últimas 6h: ${unexpectedTotal}`);
  });
});
