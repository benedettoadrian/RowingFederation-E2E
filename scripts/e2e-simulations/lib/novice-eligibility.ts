/**
 * Exact port of the backend's Novicio-eligibility algorithm, for offline
 * expected-value calculation in Fase 0.3 of the simulation (plan.md).
 * Source of truth: RowingFederation-Backend
 * src/modules/competitions/domain/services/novice-eligibility.service.ts —
 * keep this in sync if that file changes. Ported instead of imported
 * because this script lives in a separate repo/package with no dependency
 * on the backend's compiled output.
 */

function yearsAgo(years: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

export interface NoviceInscriptionRecord {
  competitionDateId: string;
  date: Date;
  isNovice: boolean;
  isWin: boolean;
}

export type NoviceIneligibilityReason = "RECENT_NON_NOVICE_HISTORY" | "FIVE_NOVICE_WINS";

export interface NoviceEligibilityResult {
  isEligible: boolean;
  reason?: NoviceIneligibilityReason;
}

export const WIN_THRESHOLD = 5;

export function evaluateNoviceEligibility(
  records: NoviceInscriptionRecord[],
  now: Date = new Date()
): NoviceEligibilityResult {
  if (records.length === 0) {
    return { isEligible: true };
  }

  const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime());
  const lastOverall = sorted[sorted.length - 1]!.date;

  if (lastOverall <= yearsAgo(2, now)) {
    return { isEligible: true };
  }

  let eraStartIndex = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i - 1]!.date <= yearsAgo(2, sorted[i]!.date)) {
      eraStartIndex = i;
      break;
    }
  }
  const currentEra = sorted.slice(eraStartIndex);

  const hasNonNoviceHistory = currentEra.some((r) => !r.isNovice);
  if (hasNonNoviceHistory) {
    return { isEligible: false, reason: "RECENT_NON_NOVICE_HISTORY" };
  }

  const winCompetitionDateIds = new Set(
    currentEra.filter((r) => r.isNovice && r.isWin).map((r) => r.competitionDateId)
  );
  if (winCompetitionDateIds.size >= WIN_THRESHOLD) {
    return { isEligible: false, reason: "FIVE_NOVICE_WINS" };
  }

  return { isEligible: true };
}
