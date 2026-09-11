/**
 * Fase 6 prep — reads Fecha 3's real results (position/time/resultCode per
 * crew_entry) and maps each one, by its athlete-set signature, to the
 * corresponding crew_entry on the NEW competition date (created in Fase 4).
 * Read-only. Run after Fase 4/5 have created+sorteo'd the new date's
 * entries: npx tsx scripts/e2e-simulations/extract-results-recipe.ts
 *
 * Round-aware (2026-09-10, full-scale pass): almost every event has a
 * single "Final" round whose crew_entries already exist in the new date at
 * sorteo time — those go straight into `immediate`. The one exception found
 * in this competition ([1x]-SUB17-M, heats "A"/"B" -> "Final") only has its
 * HEAT crew_entries at sorteo time; the Final round's crew_entries don't
 * exist yet — the product creates them via autoDrawFinal, triggered by the
 * frontend automatically right after a heat block's results are saved. Those
 * source rows go into `pendingFinals`, keyed by athlete-set signature, to be
 * resolved by phase6-load-results.spec.ts AFTER it has saved the heats.
 */
import { writeFileSync } from "node:fs";
import { withLocalDb } from "./lib/db.js";
import { SOURCE_COMPETITION_DATE_ID } from "./config.js";
import { readState } from "./lib/ui.js";

interface ResultRow {
  crewEntryId: string;
  eventId: string;
  eventCode: string;
  series: string | null;
  position: number | null;
  time: string | null;
  resultCode: string;
  athleteIds: string[];
}

const isFinalSeries = (series: string | null) => (series ?? "").toLowerCase().includes("final");

async function main() {
  const state = readState();
  if (!state.competitionDateId) throw new Error("Run phase1-create-date first.");
  const newDateId = state.competitionDateId;

  const rows = await withLocalDb(async (db) => {
    async function fetchFor(competitionDateId: string): Promise<ResultRow[]> {
      const res = await db.query(
        `SELECT ce.id AS "crewEntryId", ce."eventId", e.code AS "eventCode", ce.series,
                r.position, r.time, COALESCE(r."resultCode", 'FINISHED') AS "resultCode"
         FROM crew_entries ce
         JOIN events e ON e.id = ce."eventId"
         LEFT JOIN crew_entry_results r ON r."crewEntryId" = ce.id
         WHERE ce."competitionDateId" = $1`,
        [competitionDateId]
      );
      const out: ResultRow[] = [];
      for (const row of res.rows) {
        const membersRes = await db.query(
          `SELECT "athleteId" FROM crew_members WHERE "crewEntryId" = $1 AND "removedAt" IS NULL ORDER BY "athleteId"`,
          [row.crewEntryId]
        );
        out.push({ ...row, athleteIds: membersRes.rows.map((m: any) => m.athleteId) });
      }
      return out;
    }

    const sourceRows = await fetchFor(SOURCE_COMPETITION_DATE_ID);
    const newRows = await fetchFor(newDateId);
    return { sourceRows, newRows };
  });

  const newBySignature = new Map<string, ResultRow>();
  for (const r of rows.newRows) {
    const key = `${r.eventId}::${r.athleteIds.sort().join(",")}`;
    newBySignature.set(key, r);
  }

  interface ImmediateEntry {
    newCrewEntryId: string;
    eventId: string;
    eventCode: string;
    series: string | null;
    position: number | null;
    time: string | null;
    resultCode: string;
    // Tracks whether THIS entry's value came from a source Final row —
    // internal to the dedup below, stripped before writing the file.
    _fromFinalSrc: boolean;
  }
  // Keyed by newCrewEntryId, not pushed straight into an array — see the
  // dedup note below.
  const immediateByCrewId = new Map<string, ImmediateEntry>();
  const pendingFinals: {
    eventId: string;
    eventCode: string;
    athleteIds: string[];
    position: number | null;
    time: string | null;
    resultCode: string;
  }[] = [];
  let unmatched = 0;

  for (const src of rows.sourceRows) {
    const key = `${src.eventId}::${src.athleteIds.sort().join(",")}`;
    const match = newBySignature.get(key);
    if (!match) {
      unmatched += 1;
      continue;
    }
    // If the new date's crew_entry for this roster is already sitting in a
    // Final-labeled series, or the source row itself isn't a Final round
    // (i.e. it's the heat round, and the new entry currently IS the heat
    // entry), this is directly loadable right now.
    if (isFinalSeries(match.series) || !isFinalSeries(src.series)) {
      // Real bug found (2026-09-10, a run whose sorteo happened to NOT split
      // this roster's event into heats at all): the source date can have
      // BOTH a heat row and a Final row for the same roster+event (Fecha 3's
      // heat/final split), and when the new date collapsed both into ONE
      // round, this branch's condition is true for EITHER source row —
      // pushing two conflicting entries for the same newCrewEntryId (heat
      // position AND Final position), so whichever got filled last in the
      // UI silently overwrote the other, failing verifyBlockPersisted's
      // check against the OTHER one forever. A single "Final" round on the
      // new date should always reflect the historical FINAL result, not the
      // heat result, so prefer a Final source row over a heat source row on
      // conflict — and prefer either over a second row of the same kind
      // (arbitrary but harmless, real values already match in that case).
      const existing = immediateByCrewId.get(match.crewEntryId);
      if (!existing || (isFinalSeries(src.series) && !existing._fromFinalSrc)) {
        immediateByCrewId.set(match.crewEntryId, {
          newCrewEntryId: match.crewEntryId,
          eventId: src.eventId,
          eventCode: src.eventCode,
          series: match.series,
          position: src.position,
          time: src.time,
          resultCode: src.resultCode,
          _fromFinalSrc: isFinalSeries(src.series),
        });
      }
    } else {
      // Source row is a Final, but the new date's matching crew_entry is
      // still a heat entry (Final not auto-drawn yet) — resolve later.
      pendingFinals.push({
        eventId: src.eventId,
        eventCode: src.eventCode,
        athleteIds: src.athleteIds,
        position: src.position,
        time: src.time,
        resultCode: src.resultCode,
      });
    }
  }
  const immediate = [...immediateByCrewId.values()].map(({ _fromFinalSrc, ...rest }) => rest);

  const outPath = new URL("./output/results-recipe.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify({ immediate, pendingFinals, unmatched }, null, 2));
  console.log(
    `Immediate: ${immediate.length} results across ${new Set(immediate.map((m) => `${m.eventCode}::${m.series}`)).size} block(s).`
  );
  console.log(`Pending finals (need auto-draw first): ${pendingFinals.length}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Written to ${outPath.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
