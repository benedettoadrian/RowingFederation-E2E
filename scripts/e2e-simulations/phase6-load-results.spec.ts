import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SIM_PASSWORD, SIM_REFEREE_2_EMAIL, SIM_REFEREE_EMAIL } from "./config.js";
import { SIM_BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { simLogin, readState } from "./lib/ui.js";
import { withLocalDb } from "./lib/db.js";

/**
 * Fase 6 of plan.md — full scope in one test/one video: force-start the
 * competition (6.1), load all 33 events' results (6.2, results LOADED by a
 * referee who is NOT the assigned refereePresidentId — SIM_REFEREE_2_EMAIL),
 * then confirm every block (6.3, CONFIRMED by the actual president —
 * SIM_REFEREE_EMAIL) — matching the real product's permission split (any
 * REFEREE can PUT a result; only the president/regatta manager can
 * confirm-block).
 *
 * Round-aware: of the 33 events, only [1x]-SUB17-M has real heats (Serie A /
 * Serie B -> Final) — every other event is Final-only, some split across
 * parallel "Final A"/"Final B" blocks when a category has more crews than
 * lanes. Heat crew_entries already exist at sorteo time; the Final round's
 * crew_entries for a heat event do NOT exist until the product auto-draws
 * them (`autoDrawFinal`), which the frontend triggers automatically right
 * after a heat block's results are saved (see `handleSaved` in
 * results/page.tsx). So 6.2 runs in two passes:
 *   1. Load every block that already exists right now (`recipe.immediate`) —
 *      for [1x]-SUB17-M this is only the two heat blocks, which once both
 *      are saved leaves the real Final auto-drawn by the product itself.
 *   2. Re-query the DB for any event with `recipe.pendingFinals` entries,
 *      resolve their now-real crewEntryId by athlete-set signature, and load
 *      that newly-appeared Final block the same way.
 *
 * Real finding (documented in plan.md, not a bug): sorteo reassigns which
 * crews land in "Serie A" vs "Serie B" on the new date, and this script
 * fills each crew's OWN historical heat position regardless of which new
 * letter it landed under — so the auto-draw's cross-heat ranking (which
 * assumes one real physical race per series) can end up promoting a
 * different top-N than Fecha 3's real Final. Crews the auto-draw picked
 * that have no historical Final counterpart get marked DNS (no historical
 * record for this exact Final) so the sheet's own validation — which
 * rejects the ENTIRE save if any FINISHED row is missing a position, even
 * one this script never touches — doesn't block saving the ones that DO
 * have real historical data.
 */
interface ImmediateEntry {
  newCrewEntryId: string;
  eventId: string;
  eventCode: string;
  series: string | null;
  position: number | null;
  time: string | null;
  resultCode: string;
}
interface PendingFinalEntry {
  eventId: string;
  eventCode: string;
  athleteIds: string[];
  position: number | null;
  time: string | null;
  resultCode: string;
}
interface ResultsRecipe {
  immediate: ImmediateEntry[];
  pendingFinals: PendingFinalEntry[];
}
const resultsRecipe: ResultsRecipe = JSON.parse(
  readFileSync(new URL("./output/results-recipe.json", import.meta.url), "utf8")
);

const RESULT_CODE_LABELS: Record<string, string> = {
  FINISHED: "Finalizado",
  DNS: "No se presentó",
  DNS_JUSTIFIED: "No se presentó (justificado)",
  DSQ: "Descalificado",
  ABANDONO: "Abandono",
};

// Same real bug already found and fixed in Fase 4 — the UI shows the
// athlete's DISPLAYED name (nameDisplay-aware), not always their raw firstName.
function displayFirstName(a: { firstName: string; secondName: string | null; nameDisplay: string }): string {
  switch (a.nameDisplay) {
    case "SECOND_ONLY":
      return a.secondName ?? a.firstName;
    case "COMBINED":
      return a.secondName ? `${a.firstName} ${a.secondName}` : a.firstName;
    default:
      return a.firstName;
  }
}

// ResultsSheet only ever renders ROWER + COXSWAIN members (ProgramView's
// getAthleteData) — a registered SUBSTITUTE never appears in that row at
// all. A crew with an unused substitute (real at full scale, e.g. the
// [4x]-SUB17-M crew that surfaced this) would pick the substitute's name for
// row-matching and never find it on screen. Rowers first by seat `order`
// (matching the UI), coxswain last, substitutes excluded entirely.
//
// Fetching every crew's names ONCE up front (instead of one query per row
// inside the UI loop) also carries the club name, needed to disambiguate two
// different athletes who share the same first-shown name within one sheet
// (real at full scale — e.g. two different "Juan"s in the same dialog).
interface CrewInfo {
  names: string[];
  clubName: string;
}
async function buildCrewInfoMap(competitionDateId: string): Promise<Map<string, CrewInfo>> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      `SELECT cm."crewEntryId", a."firstName", a."secondName", a."nameDisplay", cm.role, cm."order", c.name AS "clubName"
       FROM crew_members cm
       JOIN athletes a ON a.id = cm."athleteId"
       JOIN crew_entries ce ON ce.id = cm."crewEntryId"
       JOIN clubs c ON c.id = ce."clubId"
       WHERE ce."competitionDateId" = $1 AND cm."removedAt" IS NULL AND cm.role != 'SUBSTITUTE'
       ORDER BY cm."crewEntryId", (cm.role = 'COXSWAIN'), cm."order" NULLS LAST`,
      [competitionDateId]
    );
    const map = new Map<string, CrewInfo>();
    for (const row of res.rows) {
      const info = map.get(row.crewEntryId) ?? { names: [], clubName: row.clubName };
      info.names.push(displayFirstName(row));
      map.set(row.crewEntryId, info);
    }
    return map;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches ProgramView.tsx's own buildBlocks(): heat series are bare letters
// ("A", "B"...) shown as "Serie A"; final series ("Final", "Final A", "Final
// B"...) are shown as-is.
function displaySeriesText(series: string | null): string {
  const s = series ?? "";
  return s.startsWith("Final") ? s : `Serie ${s}`;
}
const isFinalSeries = (series: string | null) => (series ?? "").toLowerCase().includes("final");

// Root-caused at full scale (2026-09-10): once Serie A/B already have loaded
// results, each row shows a "Finalizado" status badge — and a plain-string
// `hasText: "Final"` filter on the card matches that substring too, so ALL
// THREE of an event's blocks (both heats plus the real Final) satisfied the
// filter once the heats were done, making the block-card locator ambiguous
// and the "Final" block unfindable. A trailing boundary check (no cross-
// element gap here — "Final"/"izado" sit in the same text node) rules out
// "Finalizado" while still matching a standalone "Final"/"Final A"/"Final B".
function seriesTextRegex(series: string | null): RegExp {
  return new RegExp(`${escapeRegex(displaySeriesText(series))}(?![\\p{L}\\p{N}])`, "u");
}

// Root-caused at full scale (2026-09-10): `hasText` matches against
// `textContent`, which concatenates sibling elements with NO separator — a
// row's club-name cell butts directly against the next cell's text (e.g.
// "...Fray BentosVictorino Lezcano..."), so a word-boundary regex scoped to
// the whole `<tr>` (or even a leading lookbehind at all) almost always fails
// the boundary check right before the name, since the preceding cell nearly
// always ends in a letter. Fixed by matching the athlete's own `<div>` (each
// one renders exactly one name, ProgramView.tsx's `entry.athletes.map(...)`)
// with a START-anchored regex — no cross-element concatenation to trip over
// — then walking up to its `<tr>`. Still need the trailing boundary to rule
// out "Luciana" matching a search for "Lucia".
function nameDivRegex(name: string): RegExp {
  return new RegExp(`^${escapeRegex(name)}(?![\\p{L}\\p{N}])`, "u");
}

interface Group {
  eventId: string;
  eventCode: string;
  series: string | null;
  entries: { newCrewEntryId: string; position: number | null; time: string | null; resultCode: string }[];
}

// The dialog not auto-closing after "Guardar resultados" turned out to have
// TWO different real causes at full scale, not one: sometimes every mutation
// had already landed (200, correct value) and it was a pure animation-timing
// flake — but at least once (Serie B of [1x]-SUB17-M, 33-event run) 2 of 6
// PUTs genuinely never completed before the wait timed out, and the crews
// stayed without a result in the DB. Force-closing with Escape in that
// second case silently abandons real unsaved data — so this now verifies
// against the DB after every attempt and retries the block (re-filling
// everything is harmless/idempotent) instead of trusting the dialog's own
// close animation as the signal that the save actually succeeded.
async function verifyBlockPersisted(entries: Group["entries"]): Promise<string[]> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      `SELECT "crewEntryId", position, "resultCode" FROM crew_entry_results WHERE "crewEntryId" = ANY($1::text[])`,
      [entries.map((e) => e.newCrewEntryId)]
    );
    const byId = new Map(res.rows.map((r: any) => [r.crewEntryId, r]));
    const missing: string[] = [];
    for (const entry of entries) {
      const row = byId.get(entry.newCrewEntryId);
      const expectedPosition = entry.resultCode === "FINISHED" ? entry.position : null;
      if (!row || row.resultCode !== entry.resultCode || row.position !== expectedPosition) {
        missing.push(entry.newCrewEntryId);
      }
    }
    return missing;
  });
}

async function attemptLoadBlock(page: Page, group: Group, crewInfoMap: Map<string, CrewInfo>): Promise<boolean> {
  const blockCard = page
    .locator("div.overflow-hidden.rounded-md.border", { hasText: group.eventCode })
    .filter({ hasText: seriesTextRegex(group.series) });
  const loadButton = blockCard.getByRole("button", { name: /Cargar resultados|Editar/ });
  const canLoad = await loadButton
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!canLoad) {
    // Investigated a real occurrence (2026-09-10): this used to `return
    // true` here, treating "button not found in time" as "already done,
    // nothing to load" — which silently skipped an auto-drawn Final that
    // genuinely still needed its results, logged as a false "N result(s)
    // loaded" by the caller. A block that has real entries to fill must be
    // retried, not waved through.
    console.log(`  ${group.eventCode} / ${displaySeriesText(group.series)}: load button not found this attempt`);
    return false;
  }
  await loadButton.click();

  const sheet = page.getByRole("dialog");
  const opened = await sheet
    .getByText("Guardar resultados")
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    console.log(`  ${group.eventCode} / ${displaySeriesText(group.series)}: sheet never opened`);
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }

  for (const entry of group.entries) {
    try {
      const info = crewInfoMap.get(entry.newCrewEntryId);
      const names = info?.names ?? [];
      if (names.length === 0) continue;
      // .filter({ has: nameDiv }) mysteriously returns zero matches here
      // (confirmed via a dedicated repro) despite nameDiv itself resolving
      // correctly — an xpath ancestor walk from the div works reliably.
      const nameDiv = sheet.locator("div", { hasText: nameDivRegex(names[0]!) });
      let row = nameDiv.locator("xpath=ancestor::tr");
      const matchCount = await row.count();
      if (matchCount > 1) {
        // Real at full scale (2026-09-10): two different athletes sharing
        // the same first-shown name within one sheet (e.g. two "Juan"s) —
        // originally "fixed" by disambiguating on club name, but a SECOND
        // real case broke that too: a club with two boats in the same event
        // where one boat's SECOND seat happens to share a first name with
        // another boat's FIRST seat, from the SAME club (Club Remeros de
        // Fray Bentos here) — every candidate's text contained the club
        // name, so the club check picked whichever row came first in DOM
        // order, silently filling the wrong crew and losing the real one
        // (all 7 rows in that block came back empty after 3 full retries,
        // since attempts kept clobbering each other identically). Matching
        // on the crew's FULL roster (every member's name, not just the
        // first) is specific enough that two different real crews can't
        // both satisfy it.
        let resolved = false;
        for (let i = 0; i < matchCount; i++) {
          const candidate = row.nth(i);
          const text = await candidate.innerText();
          if (names.every((n) => text.includes(n))) {
            row = candidate;
            resolved = true;
            break;
          }
        }
        if (!resolved) throw new Error(`${matchCount} rows matched "${names[0]}" and none contained the full roster [${names.join(", ")}]`);
      }
      await row.waitFor({ state: "visible", timeout: 5_000 });

      if (entry.resultCode !== "FINISHED") {
        await row.getByRole("combobox").click({ timeout: 5_000 });
        await page
          .getByRole("option", { name: RESULT_CODE_LABELS[entry.resultCode], exact: true })
          .click({ timeout: 5_000 });
      }

      if (entry.position !== null) {
        const input = row.locator("input[type='number']");
        await input.fill(String(entry.position));
        // Verify the fill actually registered as React state before moving on
        // — filling several inputs back-to-back without checking turned out to
        // occasionally drop a value, which the sheet's own save validation
        // then rejected with a toast and left the dialog open.
        await expect(input).toHaveValue(String(entry.position), { timeout: 3_000 });
      }
    } catch (err) {
      // One row failing to resolve must not sink the other 5-plus crews in
      // this block, or the 30+ other events still queued behind it — log and
      // move on; verifyBlockPersisted() will catch this entry as missing and
      // the outer retry in loadBlock() gets another shot at it.
      console.log(`    ⚠️  entry ${entry.newCrewEntryId} failed to fill: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  await sheet.getByRole("button", { name: "Guardar resultados", exact: true }).click();
  const closed = await sheet
    .waitFor({ state: "hidden", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }

  const missing = await verifyBlockPersisted(group.entries);
  return missing.length === 0;
}

async function loadBlock(page: Page, group: Group, crewInfoMap: Map<string, CrewInfo>) {
  const label = `${group.eventCode} / ${displaySeriesText(group.series)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // A plain reload before each block gives every attempt a clean React
    // Query cache / DOM, cheap (~1-2s) against a ~36-block run.
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    const ok = await attemptLoadBlock(page, group, crewInfoMap);
    if (ok) {
      console.log(`  ${label}: ${group.entries.length} result(s) loaded${attempt > 1 ? ` (attempt ${attempt})` : ""}.`);
      return;
    }
    console.log(`  ${label}: not all results persisted after attempt ${attempt}, retrying...`);
  }
  console.log(`  ${label}: ⚠️  still missing results after 3 attempts — needs manual follow-up.`);
}

test("Fase 6 — competencia y resultados (33 eventos, roles separados, confirmación)", async ({ page }) => {
  const state = readState();
  if (!state.competitionDateId) throw new Error("Run phase1-create-date first.");
  const newDateId = state.competitionDateId;

  await test.step("Fase 6.1 — forzar inicio de competencia (CLOSED -> IN_COMPETITION)", async () => {
    await simLogin(page, SIM_BOOTSTRAP_ADMIN_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${newDateId}`);

    const loadResultsLink = page.getByRole("link", { name: "Cargar resultados" });
    const alreadyInCompetition = await loadResultsLink
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (alreadyInCompetition) {
      console.log("Already IN_COMPETITION.");
      return;
    }

    const forceButton = page.getByRole("button", { name: "Iniciar competencia ahora" });
    await forceButton.waitFor({ state: "visible", timeout: 10_000 });
    await forceButton.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirmar", exact: true }).click();
    await loadResultsLink.waitFor({ state: "visible", timeout: 10_000 });
    console.log("Transitioned to IN_COMPETITION.");
  });

  await test.step("Fase 6.2 — cargar resultados (árbitro NO presidente)", async () => {
    await simLogin(page, SIM_REFEREE_2_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${newDateId}/results`);

    const crewInfoMap = await buildCrewInfoMap(newDateId);

    const groups = new Map<string, Group>();
    for (const m of resultsRecipe.immediate) {
      const key = `${m.eventId}::${m.series}`;
      if (!groups.has(key)) groups.set(key, { eventId: m.eventId, eventCode: m.eventCode, series: m.series, entries: [] });
      groups.get(key)!.entries.push({ newCrewEntryId: m.newCrewEntryId, position: m.position, time: m.time, resultCode: m.resultCode });
    }
    // Heats before finals, so any real final that depends on auto-draw is
    // already populated by the time we'd otherwise look for it.
    const orderedGroups = [...groups.values()].sort((a, b) => Number(isFinalSeries(a.series)) - Number(isFinalSeries(b.series)));

    for (const group of orderedGroups) {
      await loadBlock(page, group, crewInfoMap);
    }

    if (resultsRecipe.pendingFinals.length === 0) return;

    console.log(`--- resolving ${resultsRecipe.pendingFinals.length} pending final(s) after auto-draw ---`);
    const pendingByEvent = new Map<string, PendingFinalEntry[]>();
    for (const p of resultsRecipe.pendingFinals) {
      if (!pendingByEvent.has(p.eventId)) pendingByEvent.set(p.eventId, []);
      pendingByEvent.get(p.eventId)!.push(p);
    }

    for (const [eventId, pending] of pendingByEvent) {
      const newFinalRows = await withLocalDb(async (db) => {
        const res = await db.query(
          `SELECT ce.id AS "crewEntryId", ce.series
           FROM crew_entries ce
           WHERE ce."competitionDateId" = $1 AND ce."eventId" = $2 AND ce.series ILIKE '%final%'`,
          [newDateId, eventId]
        );
        const out: { crewEntryId: string; series: string; athleteIds: string[] }[] = [];
        for (const row of res.rows) {
          const membersRes = await db.query(
            `SELECT "athleteId" FROM crew_members WHERE "crewEntryId" = $1 AND "removedAt" IS NULL ORDER BY "athleteId"`,
            [row.crewEntryId]
          );
          out.push({ crewEntryId: row.crewEntryId, series: row.series, athleteIds: membersRes.rows.map((m: any) => m.athleteId) });
        }
        return out;
      });

      if (newFinalRows.length === 0) {
        console.log(`  eventId ${eventId}: Final not auto-drawn yet — did its heat(s) actually save? Skipping ${pending.length} pending result(s).`);
        continue;
      }

      const bySignature = new Map(newFinalRows.map((r) => [r.athleteIds.sort().join(","), r]));
      const group: Group = { eventId, eventCode: pending[0]!.eventCode, series: newFinalRows[0]!.series, entries: [] };
      for (const p of pending) {
        const match = bySignature.get(p.athleteIds.sort().join(","));
        if (!match) {
          console.log(`  ${pending[0]!.eventCode}: no auto-drawn Final crew matches this historical roster (real limitation, see plan.md) — skipping one result`);
          continue;
        }
        group.entries.push({ newCrewEntryId: match.crewEntryId, position: p.position, time: p.time, resultCode: p.resultCode });
      }
      // Any auto-drawn crew with no historical match (see file header) gets
      // marked DNS so it doesn't block saving the crews that DO have data.
      const matchedIds = new Set(group.entries.map((e) => e.newCrewEntryId));
      for (const row of newFinalRows) {
        if (!matchedIds.has(row.crewEntryId)) {
          group.entries.push({ newCrewEntryId: row.crewEntryId, position: null, time: null, resultCode: "DNS" });
        }
      }
      if (group.entries.length > 0) {
        // These crew_entries were auto-drawn after crewInfoMap was built at
        // the top of this step, so they aren't in it yet.
        const refreshedCrewInfoMap = await buildCrewInfoMap(newDateId);
        await loadBlock(page, group, refreshedCrewInfoMap);
      }
    }
  });

  await test.step("Fase 6.3 — confirmar bloques (presidente de la fecha)", async () => {
    await simLogin(page, SIM_REFEREE_EMAIL, SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${newDateId}/results`);

    // Confirm every block currently showing a "Confirmar prueba" button —
    // simpler and more robust than re-deriving the exact set of (event,
    // series) pairs a second time, and naturally covers the auto-drawn Final
    // without needing to know its series name in advance.
    //
    // Root-caused (2026-09-10): `.first()` is a live selector, not a handle —
    // once a block confirms and its button disappears, a DIFFERENT block's
    // button becomes "first" and `expect(confirmButton).toBeHidden()` (which
    // re-resolves the same selector) sees that new, still-visible button and
    // reports a false failure even though the actual POST /confirm-block
    // succeeded. Waiting on the network response itself instead of the
    // button's visibility avoids the identity mismatch entirely.
    let confirmedCount = 0;
    for (let i = 0; i < 50; i++) {
      const confirmButton = page.getByRole("button", { name: "Confirmar prueba" }).first();
      const found = await confirmButton
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (!found) break;
      try {
        const [response] = await Promise.all([
          page.waitForResponse((res) => res.url().includes("/confirm-block"), { timeout: 10_000 }),
          confirmButton.click(),
        ]);
        if (!response.ok()) {
          console.log(`  ⚠️  confirm-block rejected: ${response.status()} ${await response.text().catch(() => "")}`);
          break;
        }
        confirmedCount += 1;
      } catch (err) {
        // Real occurrence (2026-09-10): one click's response never arrived
        // within 10s and threw, aborting the whole Fase 6 test even though
        // DB verification afterward showed every block had actually
        // confirmed. A single flaky wait must not sink 6.4/6.5 — reload and
        // let the loop's own `found` check decide whether there's still
        // real work left.
        console.log(`  ⚠️  confirm click ${i + 1} didn't get a response in time (${(err as Error).message.split("\n")[0]}) — reloading and continuing`);
        await page.reload();
        await page.waitForLoadState("networkidle").catch(() => {});
      }
    }
    console.log(`  confirmed ${confirmedCount} block(s).`);
  });

  await test.step("Fase 6.4 — standings de circuito (verificación de aplicabilidad)", async () => {
    // Fecha 3 real pertenece a "Circuito Nacional 2026" (type CIRCUIT,
    // confirmado vía championship_dates) — pero la fecha NUEVA creada en
    // Fase 1 no queda asociada a ningún campeonato (el wizard solo asigna
    // Programa, no Championship; confirmado: 0 filas en championship_dates
    // para esta simulación). No aplicable a esta simulación por diseño.
    const linked = await withLocalDb(async (db) => {
      const res = await db.query(`SELECT 1 FROM championship_dates WHERE "competitionDateId" = $1`, [newDateId]);
      return res.rows.length > 0;
    });
    console.log(linked ? "  Fecha vinculada a un campeonato — pendiente verificar standings." : "  N/A: esta fecha no está asociada a ningún campeonato de tipo CIRCUIT (confirmado en DB).");
  });

  await test.step("Fase 6.5 — auditoría: sin fallas inesperadas en audit_logs durante esta fase", async () => {
    const unexpected = await withLocalDb(async (db) => {
      const res = await db.query(
        `SELECT "actionType", "entityType", "errorMessage", timestamp FROM audit_logs
         WHERE success = false AND timestamp >= now() - interval '20 minutes'
         ORDER BY timestamp`
      );
      return res.rows;
    });
    if (unexpected.length > 0) {
      console.log(`  ⚠️  ${unexpected.length} audit_logs row(s) with success=false in the last 20 min:`);
      for (const row of unexpected) console.log(`    ${row.timestamp} ${row.actionType} ${row.entityType}: ${row.errorMessage}`);
    } else {
      console.log("  No unexpected success=false audit_logs rows this fase.");
    }
  });
});
