import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SIM_PASSWORD, simDelegateEmail } from "./config.js";
import { SIM_BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { simLogin, readState } from "./lib/ui.js";
import { withLocalDb } from "./lib/db.js";

/**
 * Fase 4 of plan.md — full scope in one test/one video: pilot inscriptions
 * (Club Nacional de Regatas + FUR/atleta libre), the club-isolation and
 * eligibility validations that depend on the pilot's data, then the
 * remaining 8 real clubs' inscriptions (163 entries). One shared `page`
 * throughout — a real degradation was once traced to the frontend dev
 * server's own memory bloat across a very long session (4GB+), not to page
 * reuse itself (see plan.md); a fresh dev server per marathon run is the
 * actual mitigation, not per-club page churn.
 */
interface Recipe {
  entries: {
    crewEntryId: string;
    clubId: string;
    eventId: string;
    members: { athleteId: string; role: string; order: number | null }[];
  }[];
  events: { eventId: string; code: string; name: string }[];
  athletes: {
    athleteId: string;
    firstName: string;
    secondName: string | null;
    nameDisplay: string;
    firstSurname: string;
  }[];
  clubs: { clubId: string; clubName: string; slug: string; entryCount: number }[];
}

const recipe: Recipe = JSON.parse(
  readFileSync(new URL("./output/recipe.json", import.meta.url), "utf8")
);

const CLUB_NACIONAL_ID = "YY5rcEFFYMkMbqn3Xa2RB";
const FUR_ID = "846d4ed9-dfe2-4bd1-8647-14114b7a23d9";
const ALREADY_DONE_IN_PILOT = new Set([CLUB_NACIONAL_ID, FUR_ID]);

/** Event codes contain regex-special chars (e.g. "[1x]-MASTER-M") — escape before building a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Real root cause found (NOT a product bug — a gap in this script's own
 * recipe): 7 of 141 athletes have `nameDisplay` set to SECOND_ONLY or
 * COMBINED, so the eligible-athletes list shows their second name instead
 * of (or alongside) their first — e.g. Juan Bautista Monasterio displays
 * as "Monasterio, Bautista", not "Monasterio, Juan". Matching by raw
 * firstName made those athletes (and every crewmate paired with them, once
 * the loop aborted on the unmatched member) look "not offered as
 * eligible" — a huge false-positive cascade despite the backend correctly
 * returning them as eligible the whole time (confirmed via direct API
 * response inspection). Mirrors the Frontend's own
 * formatDisplayFirstName (src/lib/utils/athlete-name.ts) exactly.
 */
function displayFirstName(a: Recipe["athletes"][number]): string {
  switch (a.nameDisplay) {
    case "SECOND_ONLY":
      return a.secondName ?? a.firstName;
    case "COMBINED":
      return a.secondName ? `${a.firstName} ${a.secondName}` : a.firstName;
    default:
      return a.firstName;
  }
}

/**
 * Fase 0.2's real finding: athletes who crossed an age-category boundary
 * between Fecha 3 (April) and SIMULATION_DATE (November) — e.g. Agustina
 * Sauco, 12 -> 13, no longer fits Sub13. The system correctly excludes
 * them from the eligible-athletes list entirely (not shown, not even as
 * "Ya inscripto"), so those crew_entries can't be recreated as-is on the
 * new date. Skip them here (not a bug — confirmed live) rather than
 * hanging on a row that will never appear.
 */
const ageCategoryMismatches: { crewEntryId: string; athleteName: string }[] = JSON.parse(
  readFileSync(new URL("./output/age-category-mismatches.json", import.meta.url), "utf8")
).mismatches;
const SKIP_CREW_ENTRY_IDS = new Set(ageCategoryMismatches.map((m) => m.crewEntryId));

async function countExistingEntries(
  competitionDateId: string,
  clubId: string,
  eventId: string
): Promise<number> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      `SELECT count(*) FROM crew_entries WHERE "competitionDateId"=$1 AND "clubId"=$2 AND "eventId"=$3`,
      [competitionDateId, clubId, eventId]
    );
    return Number(res.rows[0].count);
  });
}

/** Thrown when a crew_entry can't be recreated because one of its athletes
 * is already committed elsewhere in the same event — see below. */
class SkippedEntryError extends Error {}

async function createInscription(
  page: Page,
  competitionDateId: string,
  entry: Recipe["entries"][number],
  opts: { clubLabel?: string; strictNameMatch: boolean }
) {
  const event = recipe.events.find((e) => e.eventId === entry.eventId)!;

  await page.goto(`/es/competitions/dates/${competitionDateId}/inscriptions/new`);

  if (opts.clubLabel) {
    await page.getByLabel("Club", { exact: true }).click();
    await page.getByRole("option", { name: opts.clubLabel, exact: true }).click();
  }

  await page.getByLabel("Prueba", { exact: true }).click();
  await page.getByRole("option", { name: new RegExp(escapeRegex(event.code)) }).click();

  for (const member of entry.members) {
    const athlete = recipe.athletes.find((a) => a.athleteId === member.athleteId)!;
    const buttonLabel = member.role === "ROWER" ? "Remero" : "Suplente";

    if (!opts.strictNameMatch) {
      // Pilot scope (2 small clubs, no repeated first names) — plain
      // firstName substring match is enough and keeps the pilot flow simple.
      const row = page.locator("li", { hasText: athlete.firstName });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole("button", { name: buttonLabel }).click();
      continue;
    }

    const shownFirstName = displayFirstName(athlete);
    // Matching by first name alone breaks when a club has two athletes
    // sharing one (real case found: two "Facundo"s at Liebig's Rowing
    // Club) — the list displays "Apellido, Nombre", so match that whole
    // pattern instead. Uses the athlete's actual DISPLAYED first name
    // (nameDisplay-aware, see displayFirstName above), not necessarily
    // their raw firstName.
    const displayName = new RegExp(`^${escapeRegex(athlete.firstSurname)}, ${escapeRegex(shownFirstName)}`);
    const row = page.locator("li").filter({ hasText: displayName });

    // Root cause found and fixed here (this was the actual bug behind a
    // huge false-positive "not eligible" cascade across Alemán/Paysandú/
    // Fray Bentos): Locator.isVisible({timeout}) does NOT poll/retry the
    // way expect(locator).toBeVisible() does — it's close to an immediate
    // snapshot check, so it was firing before the CrewBuilder's async
    // eligible-athletes fetch had rendered. A careful manual walkthrough of
    // the exact same 17 Alemán entries, waiting properly, found every
    // single supposedly-missing athlete present the whole time. Fixed by
    // using .waitFor(), which does poll for the full timeout.
    const rowAppeared = await row
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!rowAppeared) {
      throw new SkippedEntryError(
        `${athlete.firstSurname}, ${shownFirstName} not offered as eligible for ${event.code} (not shown in the eligible-athletes list at all)`
      );
    }
    const alreadyInscribed = await row
      .getByText("Ya inscripto")
      .waitFor({ state: "visible", timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (alreadyInscribed) {
      throw new SkippedEntryError(
        `${athlete.firstSurname}, ${shownFirstName} already committed to another crew in ${event.code} (series/heat overlap in the source data)`
      );
    }

    await row.getByRole("button", { name: buttonLabel }).click();
  }

  await page.getByRole("button", { name: "Guardar inscripción", exact: true }).click();

  // Real product feature (InscriptionConflictWarningDialog), not a bug: a
  // client-side "proximity warning" pops up when an athlete is entered in
  // two events fewer than 3 slots apart in the program — with 166 real
  // entries reusing the same limited roster per club, this triggers for
  // real. Confirm through it when it appears.
  const proximityDialog = page.getByRole("dialog", { name: "Advertencia de proximidad" });
  if (await proximityDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await proximityDialog.getByRole("button", { name: "Confirmar igual" }).click();
  }

  await page.waitForURL(/\/inscriptions(?!\/new)/, { timeout: 10_000 });
}

/**
 * Real finding (Club Remeros Salto, [1x]-SUB17-M): Fecha 3 has the SAME
 * solo athlete in two separate crew_entries for the identical event,
 * differing only by `series` ("B" vs "Final"). That's not two manual
 * inscriptions — it's the heat/final split the ORIGINAL sorteo generated
 * for that entrant (confirmed: both ACTIVE, `series` is only ever set at
 * sorteo/results time per the codebase's own docs, never at inscription
 * time). Recreating both via /inscriptions/new is neither possible — the
 * UI correctly refuses to double-book the same athlete into the same
 * event — nor meaningful, since the fresh date's own sorteo (Fase 5) will
 * generate its own heat/final split. Dedupe by (event, athlete-set) before
 * replaying.
 */
function dedupeByEventAndRoster(entries: Recipe["entries"]): Recipe["entries"] {
  const seen = new Set<string>();
  const result: Recipe["entries"] = [];
  for (const e of entries) {
    const key = `${e.eventId}::${[...e.members.map((m) => m.athleteId)].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(e);
  }
  return result;
}

async function createClubInscriptions(
  page: Page,
  competitionDateId: string,
  rawEntriesIn: Recipe["entries"],
  opts: { clubLabel?: string; strictNameMatch: boolean }
): Promise<number> {
  const rawEntries = rawEntriesIn.filter((e) => {
    if (!SKIP_CREW_ENTRY_IDS.has(e.crewEntryId)) return true;
    console.log(`    skipping crewEntry ${e.crewEntryId}: real age-category mismatch (Fase 0.2), not reproducible on the new date`);
    return false;
  });
  const entries = dedupeByEventAndRoster(rawEntries);
  if (entries.length < rawEntries.length) {
    console.log(
      `    (deduped ${rawEntries.length - entries.length} heat/final-split duplicate(s) — same athlete-set + event, different series)`
    );
  }
  const expectedByEvent = new Map<string, number>();
  for (const e of entries) expectedByEvent.set(e.eventId, (expectedByEvent.get(e.eventId) ?? 0) + 1);

  const doneByEvent = new Map<string, number>();
  let created = 0;
  let skipped = 0;
  for (const entry of entries) {
    const doneSoFar = doneByEvent.get(entry.eventId) ?? 0;
    const existing =
      doneSoFar === 0
        ? await countExistingEntries(competitionDateId, entry.clubId, entry.eventId)
        : doneSoFar;
    if (doneSoFar === 0 && existing >= (expectedByEvent.get(entry.eventId) ?? 0)) {
      doneByEvent.set(entry.eventId, expectedByEvent.get(entry.eventId)!);
      continue;
    }
    if (doneSoFar >= (expectedByEvent.get(entry.eventId) ?? 0)) continue;

    try {
      await createInscription(page, competitionDateId, entry, opts);
      created += 1;
      doneByEvent.set(entry.eventId, doneSoFar + 1);
    } catch (err) {
      if (!(err instanceof SkippedEntryError)) throw err;
      console.log(`    skipping crewEntry ${entry.crewEntryId}: ${err.message}`);
      skipped += 1;
      // Not incrementing doneByEvent: this slot in the expected count for
      // this event is permanently short by one (a real, deterministic
      // consequence of the source data's series overlap, not a bug in the
      // running total) — a re-run will hit the same skip, not retry forever.
    }
  }
  if (skipped > 0) console.log(`    (${skipped} entry/entries skipped: athlete already committed elsewhere in the same event)`);
  return created;
}

test("Fase 4 — inscripciones (piloto + validaciones + escalado a los 10 clubes reales)", async ({ page }) => {
  const state = readState();
  if (!state.competitionDateId) throw new Error("Run phase1-create-date first.");
  const competitionDateId = state.competitionDateId;

  await test.step("Fase 4.1 — piloto: Club Nacional de Regatas", async () => {
    const clubNacional = recipe.clubs.find((c) => c.clubId === CLUB_NACIONAL_ID)!;
    const nacionalEntries = recipe.entries.filter((e) => e.clubId === CLUB_NACIONAL_ID);
    await simLogin(page, simDelegateEmail(clubNacional.slug), SIM_PASSWORD);
    const created = await createClubInscriptions(page, competitionDateId, nacionalEntries, { strictNameMatch: false });
    console.log(`Club Nacional de Regatas: ${created} new inscription(s) created (of ${nacionalEntries.length} expected).`);
  });

  await test.step("Fase 4.2 — piloto: FUR / atleta libre (vía ADMIN)", async () => {
    const fur = recipe.clubs.find((c) => c.clubId === FUR_ID)!;
    const furEntries = recipe.entries.filter((e) => e.clubId === FUR_ID);
    await simLogin(page, SIM_BOOTSTRAP_ADMIN_EMAIL, SIM_PASSWORD);
    // Real DB name is "Federación Uruguaya de Remo", but the club select
    // shows it under a friendlier special-cased label — confirmed live.
    const created = await createClubInscriptions(page, competitionDateId, furEntries, {
      clubLabel: "Atleta Libre (FUR)",
      strictNameMatch: false,
    });
    console.log(`${fur.clubName}: ${created} new inscription(s) created (of ${furEntries.length} expected).`);
  });

  await test.step("Fase 4.3 — aislamiento: el delegado solo ve las inscripciones de su propio club", async () => {
    const clubNacional = recipe.clubs.find((c) => c.clubId === CLUB_NACIONAL_ID)!;
    await simLogin(page, simDelegateEmail(clubNacional.slug), SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}/inscriptions`);

    // The list groups by event (one header per prueba, "· N botes"), not one
    // row per crew — own club's 2 events must show up with the right crew count...
    await expect(page.getByText("[1x]-MASTER-M")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("· 2 botes")).toBeVisible();
    await expect(page.getByText("[2x]-MASTER-M")).toBeVisible();
    // Appears twice each (single + double crew) — check presence, not strict uniqueness.
    await expect(page.getByText("Ivan Malan").first()).toBeVisible();
    await expect(page.getByText("Juan Poch").first()).toBeVisible();

    // The list shows the full program catalog (all 33 events, "· Sin
    // inscripciones" for ones this club hasn't entered) — so [1x]-SENIOR-M
    // itself legitimately appears as a catalog row. What must NEVER leak is
    // another club's actual crew/athlete inside it.
    await expect(page.getByText("[1x]-SENIOR-M")).toBeVisible();
    await expect(page.getByText("Gennaro Melonio")).toHaveCount(0);
    await expect(page.getByText("Atleta Libre (FUR)")).toHaveCount(0);
    console.log("Club isolation OK: delegate sees only its own club's inscriptions.");
  });

  await test.step("Fase 4.4 — elegibilidad club+categoría en el buscador de tripulación", async () => {
    const clubNacional = recipe.clubs.find((c) => c.clubId === CLUB_NACIONAL_ID)!;
    await simLogin(page, simDelegateEmail(clubNacional.slug), SIM_PASSWORD);
    await page.goto(`/es/competitions/dates/${competitionDateId}/inscriptions/new`);
    await page.getByLabel("Prueba", { exact: true }).click();
    await page.getByRole("option", { name: /\[1x\]-MASTER-M/ }).click();

    // Wait for the async eligible-athletes fetch (useEligibleAthletes) to
    // resolve instead of reading the list immediately — same race condition
    // class as the earlier status-button check in phase1.
    await expect(page.getByText("Atletas del club")).toBeVisible({ timeout: 10_000 });
    const athleteRows = page.locator("li").filter({ hasText: /Ya inscripto|Remero|Suplente/ });
    await expect(athleteRows.first()).toBeVisible({ timeout: 10_000 });

    const count = await athleteRows.count();
    const namesShown = (await athleteRows.allInnerTexts()).map((n) => n.replace(/\s+/g, " ").trim());
    console.log(`Eligible-athletes list for [1x]-MASTER-M (Club Nacional de Regatas): ${count} athlete(s) shown.`);
    console.log(namesShown.join(" | "));

    // Both club athletes must appear (already-inscribed, since both singles
    // already used them) — this confirms the list is scoped to the CLUB, not
    // hiding everyone who's busy.
    expect(namesShown.some((n) => n.includes("Malan"))).toBe(true);
    expect(namesShown.some((n) => n.includes("Poch"))).toBe(true);

    // Gennaro Melonio (FUR's own athlete, a different club entirely) must
    // never show up here — cross-club leakage would be a real bug.
    await expect(page.getByText("Melonio")).toHaveCount(0);
  });

  await test.step("Fase 4.5 — escalado completo (8 clubes restantes)", async () => {
    if (!state.delegatesByClubId) throw new Error("Run phase2-create-users first.");
    const remainingClubs = recipe.clubs.filter((c) => !ALREADY_DONE_IN_PILOT.has(c.clubId));
    let totalCreated = 0;

    for (const club of remainingClubs) {
      const delegate = state.delegatesByClubId[club.clubId];
      if (!delegate) throw new Error(`No delegate on record for ${club.clubName} (${club.clubId})`);

      const clubEntries = recipe.entries.filter((e) => e.clubId === club.clubId);
      await test.step(`${club.clubName} — ${clubEntries.length} inscripciones`, async () => {
        await simLogin(page, delegate.email, SIM_PASSWORD);
        const created = await createClubInscriptions(page, competitionDateId, clubEntries, { strictNameMatch: true });
        totalCreated += created;
        console.log(`  ${club.clubName}: ${created} new (of ${clubEntries.length} expected)`);
      });
    }
    console.log(`Fase 4.5 done. Total new inscriptions created this run: ${totalCreated}`);
  });
});
