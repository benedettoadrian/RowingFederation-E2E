/**
 * Fase 0.2 of plan.md — cross-checks every athlete in the recipe against
 * the age-category range of the event they were inscribed in, but using
 * their age AT THE NEW (cloned) COMPETITION DATE instead of at Fecha 3's
 * original date. Flags every case where the athlete no longer fits — real
 * category boundaries may have been crossed between April (Fecha 3) and
 * SIMULATION_DATE (config.ts).
 *
 * Read-only, no writes. Run after extract-recipe.ts:
 *   npx tsx scripts/e2e-simulations/check-age-categories.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SIMULATION_DATE } from "./config.js";

interface Recipe {
  entries: {
    crewEntryId: string;
    clubId: string;
    eventId: string;
    members: { athleteId: string; role: string; order: number | null }[];
  }[];
  events: {
    eventId: string;
    code: string;
    name: string;
    ageCategoryName: string;
    minAge: number;
    maxAge: number | null;
  }[];
  athletes: {
    athleteId: string;
    firstName: string;
    firstSurname: string;
    birthdate: string;
  }[];
}

/**
 * Real bug found and fixed here (discovered live in Fase 4.5, Club Remeros
 * Paysandú — an athlete correctly shown as eligible by the real UI came up
 * as "ineligible" against this script's original calculation): the system
 * does NOT use exact calendar age. `AgeEligibilityVO.check`
 * (RowingFederation-Backend/src/modules/competitions/domain/value-objects/
 * age-eligibility.vo.ts) uses the FISA/World Rowing standard —
 * `competitionYear - birthYear`, exact birthday within the year is never
 * considered. Matching that exactly here, not reinventing "real" age.
 */
function ageAt(birthdate: Date, at: Date): number {
  return at.getFullYear() - birthdate.getFullYear();
}

function main() {
  const recipePath = new URL("./output/recipe.json", import.meta.url);
  const recipe: Recipe = JSON.parse(readFileSync(recipePath, "utf8"));

  const eventById = new Map(recipe.events.map((e) => [e.eventId, e]));
  const athleteById = new Map(recipe.athletes.map((a) => [a.athleteId, a]));

  const mismatches: {
    crewEntryId: string;
    eventCode: string;
    ageCategoryName: string;
    minAge: number;
    maxAge: number | null;
    athleteId: string;
    athleteName: string;
    ageAtSimulationDate: number;
  }[] = [];

  for (const entry of recipe.entries) {
    const event = eventById.get(entry.eventId);
    if (!event) continue;
    for (const member of entry.members) {
      const athlete = athleteById.get(member.athleteId);
      if (!athlete) continue;
      const age = ageAt(new Date(athlete.birthdate), SIMULATION_DATE);
      const fitsMin = age >= event.minAge;
      const fitsMax = event.maxAge === null || age <= event.maxAge;
      if (!fitsMin || !fitsMax) {
        mismatches.push({
          crewEntryId: entry.crewEntryId,
          eventCode: event.code,
          ageCategoryName: event.ageCategoryName,
          minAge: event.minAge,
          maxAge: event.maxAge,
          athleteId: athlete.athleteId,
          athleteName: `${athlete.firstName} ${athlete.firstSurname}`,
          ageAtSimulationDate: age,
        });
      }
    }
  }

  const outPath = new URL("./output/age-category-mismatches.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify({ simulationDate: SIMULATION_DATE, mismatches }, null, 2));

  console.log(`Simulation date: ${SIMULATION_DATE.toISOString().slice(0, 10)}`);
  console.log(`${mismatches.length} athlete/event age-category mismatch(es) found.`);
  for (const m of mismatches) {
    console.log(
      `  - ${m.athleteName} (${m.athleteId}) age ${m.ageAtSimulationDate} vs ${m.eventCode} ` +
        `[${m.ageCategoryName}: ${m.minAge}-${m.maxAge ?? "∞"}] — crewEntry ${m.crewEntryId}`
    );
  }
  console.log(`Written to ${outPath.pathname}`);
}

main();
