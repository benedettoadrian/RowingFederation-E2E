/**
 * Config for the "replicate a competition date" simulation scripts —
 * see .agents/memory/projects/RowingFederation/features/fecha3-replica-e2e-simulation/plan.md
 * (IA-Claude repo) for the full plan.
 *
 * Deliberately separate from fixtures/lib/config.ts: that one points at the
 * disposable Docker E2E stack (ports 5433/3001/5174). This simulation reads
 * real local-dev data (e.g. the real "Fecha 3"), so it defaults to the local
 * dev stack ports instead (5432/3000/5173). Override via env vars if needed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const LOCAL_DB_URL =
  process.env.SIM_DATABASE_URL ??
  "postgresql://rowing_user:rowing_password@localhost:5432/rowing_federation";
export const LOCAL_API_URL = process.env.SIM_API_URL ?? "http://localhost:3000/api/v1";
export const LOCAL_APP_URL = process.env.SIM_APP_URL ?? "http://localhost:5173";

/** Source competition date to read the "recipe" from — real Fecha 3 by default. */
export const SOURCE_COMPETITION_DATE_ID =
  process.env.SIM_SOURCE_DATE_ID ?? "743d24e5-364f-4a30-8b2f-97a296ce1624";

/**
 * Calendar date the new (cloned) competition date will actually happen on —
 * used both by the Fase 0.2/0.3 expected-value calculations (age category,
 * Novicio eligibility, both evaluated "as of" this date, not as of Fecha
 * 3's original April date) and by the Fase 1 UI script that creates the new
 * date.
 *
 * Real bug found running this a second time (2026-09-10): `CompetitionDate.
 * date` is UNIQUE in the DB, and this used to be a single hardcoded default
 * — every run after the first collided with the previous run's own leftover
 * date ("A competition date already exists on this date"), exactly
 * contradicting the design's own goal of being re-runnable multiple times.
 * Resolution order now: explicit SIM_TARGET_DATE env var (manual override,
 * unchanged) -> whatever this SAME run already resolved and persisted to
 * simulation-state.json (so Fase 0.2/3.5's separate process invocations
 * agree with Fase 1's, without needing the env var threaded through every
 * command) -> otherwise pick a fresh date (today + a pseudo-random offset
 * within a ~10 year window) and persist it immediately, so it's stable for
 * the rest of THIS run but different from any prior one.
 */
function resolveSimulationDate(): Date {
  if (process.env.SIM_TARGET_DATE) return new Date(process.env.SIM_TARGET_DATE);

  const statePath = new URL("./output/simulation-state.json", import.meta.url);
  let state: { simulationTargetDate?: string } = {};
  if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.simulationTargetDate) return new Date(state.simulationTargetDate);

  // Anchored to the original intended simulation date (~a year past Fecha
  // 3's real April 2026 date) plus a small per-run offset — enough to dodge
  // a same-day collision without drifting the "as of" date so far out that
  // it inflates how many athletes cross an age-category boundary (a run
  // landing a decade out was a real early version of this bug: technically
  // unique, but far less faithful to the intended replication).
  const anchor = new Date("2026-11-07T00:00:00.000Z");
  const daysOffset = Date.now() % 180; // ~6 month spread, changes every run
  const fresh = new Date(anchor.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  fresh.setUTCHours(0, 0, 0, 0);
  writeFileSync(statePath, JSON.stringify({ ...state, simulationTargetDate: fresh.toISOString() }, null, 2));
  return fresh;
}
export const SIMULATION_DATE = resolveSimulationDate();

/**
 * Naming convention for every user this simulation creates or looks for
 * (plan.md, Decisión D6 / Fase 0.6) — fixed and greppable, so a re-run can
 * always find what a previous run created instead of creating duplicates.
 * Not a real secret: local-dev-only fixture data.
 */
export const SIM_PASSWORD = "E2eSim123!";
export const SIM_EMAIL_DOMAIN = "fur-test.local";
export const simDelegateEmail = (clubSlug: string) =>
  `e2e-sim.delegado.${clubSlug}@${SIM_EMAIL_DOMAIN}`;
export const SIM_REGATTA_COMMISSION_EMAIL = `e2e-sim.comision@${SIM_EMAIL_DOMAIN}`;
export const SIM_REFEREE_EMAIL = `e2e-sim.referee@${SIM_EMAIL_DOMAIN}`;
/** A SECOND referee, deliberately NOT the assigned refereePresidentId — per
 * the user's explicit request, results are loaded by a field referee and
 * only CONFIRMED by the president, matching the real product's role split
 * (any REFEREE can PUT a result, only the president/regatta manager can
 * confirm-block). */
export const SIM_REFEREE_2_EMAIL = `e2e-sim.referee2@${SIM_EMAIL_DOMAIN}`;

/** Slugify a club name into the token used in simDelegateEmail. */
export function clubSlug(clubName: string): string {
  return clubName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (e.g. Alemán -> Aleman)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
