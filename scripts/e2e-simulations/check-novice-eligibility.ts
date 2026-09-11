/**
 * Fase 0.3 of plan.md — for every athlete inscribed (in the recipe) in a
 * Novicio-category event, pulls their FULL real inscription history (every
 * competition date, every category, ever — not just Fecha 3) and evaluates
 * the ported NoviceEligibilityService algorithm as of SIMULATION_DATE. The
 * output is the "expected" eligibility per athlete that Fase 3.5's UI
 * checks get compared against.
 *
 * Read-only, no writes. Run after extract-recipe.ts:
 *   npx tsx scripts/e2e-simulations/check-novice-eligibility.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Client } from "pg";
import { withLocalDb } from "./lib/db.js";
import { evaluateNoviceEligibility, type NoviceInscriptionRecord } from "./lib/novice-eligibility.js";
import { SIMULATION_DATE } from "./config.js";

interface Recipe {
  entries: {
    crewEntryId: string;
    eventId: string;
    members: { athleteId: string; role: string; order: number | null }[];
  }[];
  events: { eventId: string; code: string; isNovice: boolean }[];
  athletes: { athleteId: string; firstName: string; firstSurname: string }[];
}

async function findInscriptionHistory(
  db: Client,
  athleteId: string
): Promise<NoviceInscriptionRecord[]> {
  // Mirrors NoviceEligibilityRepository.findInscriptionHistory exactly
  // (RowingFederation-Backend/src/modules/competitions/infrastructure/
  // persistence/novice-eligibility.repository.ts) — live CrewMember rows
  // plus the pre-soft-delete originalMemberIds fallback, deduplicated by
  // crewEntry id.
  const memberRows = await db.query(
    `SELECT ce.id AS "crewEntryId", cd.id AS "competitionDateId", cd.date,
            ac."isNovice", r.position
     FROM crew_members cm
     JOIN crew_entries ce ON ce.id = cm."crewEntryId"
     JOIN competition_dates cd ON cd.id = ce."competitionDateId"
     JOIN events e ON e.id = ce."eventId"
     JOIN age_categories ac ON ac.id = e."ageCategoryId"
     LEFT JOIN crew_entry_results r ON r."crewEntryId" = ce.id
     WHERE cm."athleteId" = $1`,
    [athleteId]
  );

  const fallbackRows = await db.query(
    `SELECT ce.id AS "crewEntryId", cd.id AS "competitionDateId", cd.date,
            ac."isNovice", r.position
     FROM crew_entries ce
     JOIN competition_dates cd ON cd.id = ce."competitionDateId"
     JOIN events e ON e.id = ce."eventId"
     JOIN age_categories ac ON ac.id = e."ageCategoryId"
     LEFT JOIN crew_entry_results r ON r."crewEntryId" = ce.id
     WHERE $1 = ANY(ce."originalMemberIds")`,
    [athleteId]
  );

  const covered = new Set(memberRows.rows.map((r: any) => r.crewEntryId));
  const records: NoviceInscriptionRecord[] = memberRows.rows.map((r: any) => ({
    competitionDateId: r.competitionDateId,
    date: new Date(r.date),
    isNovice: r.isNovice,
    isWin: r.position === 1,
  }));
  for (const r of fallbackRows.rows) {
    if (covered.has(r.crewEntryId)) continue;
    records.push({
      competitionDateId: r.competitionDateId,
      date: new Date(r.date),
      isNovice: r.isNovice,
      isWin: r.position === 1,
    });
  }
  return records;
}

async function main() {
  const recipePath = new URL("./output/recipe.json", import.meta.url);
  const recipe: Recipe = JSON.parse(readFileSync(recipePath, "utf8"));

  const noviceEventIds = new Set(recipe.events.filter((e) => e.isNovice).map((e) => e.eventId));
  const athleteById = new Map(recipe.athletes.map((a) => [a.athleteId, a]));

  const noviceAthleteIds = new Set<string>();
  for (const entry of recipe.entries) {
    if (!noviceEventIds.has(entry.eventId)) continue;
    for (const m of entry.members) noviceAthleteIds.add(m.athleteId);
  }

  console.log(`${noviceEventIds.size} Novicio event(s) in the recipe, ${noviceAthleteIds.size} athlete(s) to evaluate.`);

  const results: {
    athleteId: string;
    athleteName: string;
    isEligible: boolean;
    reason?: string;
    historyCount: number;
  }[] = [];

  await withLocalDb(async (db) => {
    for (const athleteId of noviceAthleteIds) {
      const history = await findInscriptionHistory(db, athleteId);
      const evalResult = evaluateNoviceEligibility(history, SIMULATION_DATE);
      const athlete = athleteById.get(athleteId);
      results.push({
        athleteId,
        athleteName: athlete ? `${athlete.firstName} ${athlete.firstSurname}` : "(unknown)",
        isEligible: evalResult.isEligible,
        reason: evalResult.reason,
        historyCount: history.length,
      });
    }
  });

  const ineligible = results.filter((r) => !r.isEligible);
  const outPath = new URL("./output/novice-eligibility-expected.json", import.meta.url);
  writeFileSync(
    outPath,
    JSON.stringify({ simulationDate: SIMULATION_DATE, results }, null, 2)
  );

  console.log(`${results.length} evaluated, ${ineligible.length} expected INELIGIBLE as of ${SIMULATION_DATE.toISOString().slice(0, 10)}:`);
  for (const r of ineligible) {
    console.log(`  - ${r.athleteName} (${r.athleteId}) — ${r.reason} (${r.historyCount} inscriptions in history)`);
  }
  console.log(`Written to ${outPath.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
