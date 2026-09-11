/**
 * Fase 0.1 / 0.4 / 0.5 of plan.md — reads the source competition date
 * (default: real Fecha 3) and writes a self-contained "recipe" JSON that
 * the later UI-driving scripts (Fase 1+) consume. Read-only: no writes.
 *
 * Run: npx tsx scripts/e2e-simulations/extract-recipe.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { withLocalDb } from "./lib/db.js";
import { SOURCE_COMPETITION_DATE_ID, clubSlug } from "./config.js";

interface EventInfo {
  eventId: string;
  code: string;
  name: string;
  gender: string;
  distance: number;
  boatId: string;
  boatCode: string;
  ageCategoryId: string;
  ageCategoryName: string;
  minAge: number;
  maxAge: number | null;
  isMaster: boolean;
  isNovice: boolean;
}

interface MemberInfo {
  athleteId: string;
  role: string;
  order: number | null;
}

interface EntryInfo {
  crewEntryId: string;
  clubId: string;
  eventId: string;
  series: string | null;
  members: MemberInfo[];
}

interface ClubInfo {
  clubId: string;
  clubName: string;
  slug: string;
  entryCount: number;
}

interface AthleteBaseline {
  athleteId: string;
  firstName: string;
  secondName: string | null;
  nameDisplay: string;
  firstSurname: string;
  secondSurname: string | null;
  birthdate: string;
  currentClubId: string | null;
  isActive: boolean;
  status: string;
}

async function main() {
  const recipe = await withLocalDb(async (db) => {
    const dateRes = await db.query(
      `SELECT cd.id, cd.name, cd."organizingClubId", oc.name AS "organizingClubName",
              cd."programId", p.name AS "programName", cd."pistaId", pi.name AS "pistaName",
              cd."startTime", cd."finalStartTime", cd."minutesBetweenHeats", cd."minutesBetweenFinals",
              cd."handicapMethod", cd.date
       FROM competition_dates cd
       JOIN clubs oc ON oc.id = cd."organizingClubId"
       JOIN programs p ON p.id = cd."programId"
       JOIN pistas pi ON pi.id = cd."pistaId"
       WHERE cd.id = $1`,
      [SOURCE_COMPETITION_DATE_ID]
    );
    if (dateRes.rows.length === 0) {
      throw new Error(`Source competition date ${SOURCE_COMPETITION_DATE_ID} not found`);
    }
    const sourceDate = dateRes.rows[0];

    const entriesRes = await db.query(
      `SELECT ce.id AS "crewEntryId", ce."clubId", c.name AS "clubName", ce."eventId", ce.series
       FROM crew_entries ce
       JOIN clubs c ON c.id = ce."clubId"
       WHERE ce."competitionDateId" = $1
       ORDER BY c.name, ce."eventId"`,
      [SOURCE_COMPETITION_DATE_ID]
    );

    const crewEntryIds = entriesRes.rows.map((r) => r.crewEntryId);

    const membersRes = await db.query(
      `SELECT "crewEntryId", "athleteId", role, "order"
       FROM crew_members
       WHERE "crewEntryId" = ANY($1) AND "removedAt" IS NULL
       ORDER BY "crewEntryId", "order" NULLS LAST`,
      [crewEntryIds]
    );
    const membersByEntry = new Map<string, MemberInfo[]>();
    for (const m of membersRes.rows) {
      const list = membersByEntry.get(m.crewEntryId) ?? [];
      list.push({ athleteId: m.athleteId, role: m.role, order: m.order });
      membersByEntry.set(m.crewEntryId, list);
    }

    const entries: EntryInfo[] = entriesRes.rows.map((r) => ({
      crewEntryId: r.crewEntryId,
      clubId: r.clubId,
      eventId: r.eventId,
      series: r.series,
      members: membersByEntry.get(r.crewEntryId) ?? [],
    }));

    // Distinct clubs + entry counts, for Fase 0.5 pilot/scale ordering.
    const clubCounts = new Map<string, { clubName: string; count: number }>();
    for (const r of entriesRes.rows) {
      const c = clubCounts.get(r.clubId) ?? { clubName: r.clubName, count: 0 };
      c.count += 1;
      clubCounts.set(r.clubId, c);
    }
    const clubs: ClubInfo[] = [...clubCounts.entries()]
      .map(([clubId, v]) => ({
        clubId,
        clubName: v.clubName,
        slug: clubSlug(v.clubName),
        entryCount: v.count,
      }))
      .sort((a, b) => a.entryCount - b.entryCount);

    // Distinct events used, with category info (needed by Fase 0.2/0.3 and
    // by the UI-driving scripts to know which prueba to pick per entry).
    const eventIds = [...new Set(entries.map((e) => e.eventId))];
    const eventsRes = await db.query(
      `SELECT e.id AS "eventId", e.code, e.name, e.gender, e.distance,
              e."boatId", b.code AS "boatCode",
              e."ageCategoryId", ac.name AS "ageCategoryName", ac."minAge", ac."maxAge",
              ac."isMaster", ac."isNovice"
       FROM events e
       JOIN boats b ON b.id = e."boatId"
       JOIN age_categories ac ON ac.id = e."ageCategoryId"
       WHERE e.id = ANY($1)`,
      [eventIds]
    );
    const events: EventInfo[] = eventsRes.rows;

    // Distinct athletes, baseline snapshot (Fase 0.4 — before the 24h
    // bulk-activation step, so we can tell afterwards what actually changed).
    const athleteIds = [...new Set(entries.flatMap((e) => e.members.map((m) => m.athleteId)))];
    const athletesRes = await db.query(
      `SELECT id AS "athleteId", "firstName", "secondName", "nameDisplay", "firstSurname", "secondSurname", birthdate, "currentClubId", "isActive", status
       FROM athletes WHERE id = ANY($1)`,
      [athleteIds]
    );
    const athletes: AthleteBaseline[] = athletesRes.rows.map((a) => ({
      ...a,
      birthdate: new Date(a.birthdate).toISOString(),
    }));

    const pilotClubIds = clubs.slice(0, 2).map((c) => c.clubId);
    const scaleClubIds = clubs.slice(2).map((c) => c.clubId);

    return {
      extractedAt: new Date().toISOString(),
      sourceDate: {
        ...sourceDate,
        date: new Date(sourceDate.date).toISOString(),
      },
      clubs,
      events,
      entries,
      athletes,
      pilotClubIds,
      scaleClubIds,
    };
  });

  mkdirSync(new URL("./output", import.meta.url), { recursive: true });
  const outPath = new URL("./output/recipe.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(recipe, null, 2));

  console.log(`Recipe written to ${outPath.pathname}`);
  console.log(`- ${recipe.entries.length} crew entries`);
  console.log(`- ${recipe.athletes.length} distinct athletes`);
  console.log(`- ${recipe.events.length} distinct events`);
  console.log(`- ${recipe.clubs.length} clubs, pilot: ${recipe.pilotClubIds.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
