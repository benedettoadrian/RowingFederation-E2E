import { test, expect } from "@playwright/test";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api, ApiError, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Real user-reported bug (2026-08-06, in three rounds as each layer surfaced
 * the next one): a CLUB_DELEGATE could not browse/view athletes outside
 * their own club at all — the athletes list, a single athlete's profile,
 * and that athlete's requirements/documents were all silently forced to
 * (or 403'd outside) the delegate's own club. None of that should be
 * club-scoped: for a CLUB_DELEGATE, viewing is federation-wide everywhere
 * (list, profile, requirements/documents) — the only real club restriction
 * is on *write* actions: editing an athlete (frontend pencil + backend
 * updateAthlete's assertClubScope) and uploading/reviewing a requirement
 * document (uploadIdentityDoc/uploadSwimmingConsent/uploadAthleteCard/etc.,
 * still gated by assertClubScope — verified still enforced below).
 *
 * Root causes, all in the backend:
 * - athlete.controller.ts's getAthletes handler unconditionally overwrote
 *   any clubId query param with the delegate's own clubId.
 * - athlete.controller.ts's getAthleteById threw ForbiddenError outside the
 *   delegate's own club.
 * - athlete-requirements.controller.ts's getRequirements/getEligibility
 *   called assertClubScope, which does the same.
 * A fourth bug (frontend-only): the athlete detail page's canUpload prop
 * was a pure permission check (can("athletes:create")) with no club-match
 * condition, showing/enabling the upload UI for any athlete regardless of
 * club — the backend still correctly rejected the actual upload, but the
 * button shouldn't have been there. Not directly testable from this
 * API-only spec; see AthleteRequirementsSection.tsx's canUpload usage.
 */

test("a CLUB_DELEGATE can list athletes from a club that isn't their own @tier0", async () => {
  const { clubs, athletes } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE"); // scoped to clubs.club1

  const result = await api.get<{ data: { id: string; currentClubId: string }[] }>(
    `/athletes?clubId=${clubs.club2}`,
    token
  );

  expect(result.data.some((a) => a.id === athletes.club2)).toBe(true);
});

test("a CLUB_DELEGATE selecting 'all clubs' (no clubId filter) sees athletes from other clubs too @tier0", async () => {
  const { athletes } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE"); // scoped to club1

  // "ClubDos" is the seed fixture's surname suffix for the club2 athlete
  // (fixtures/seed.ts) — searching by it avoids relying on total row count
  // (fixture volume across the whole E2E run, other spec files included,
  // can exceed a single page) to prove the club2 athlete is reachable at all.
  const result = await api.get<{ data: { id: string }[] }>("/athletes?search=ClubDos", token);

  expect(result.data.some((a) => a.id === athletes.club2)).toBe(true);
});

test("a CLUB_DELEGATE can view an athlete's profile from a different club @tier0", async () => {
  const { athletes } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE"); // scoped to club1

  const result = await api.get<{ data: { id: string } }>(`/athletes/${athletes.club2}`, token);

  expect(result.data.id).toBe(athletes.club2);
});

test("a CLUB_DELEGATE can view another club's athlete's requirements/documents, but still cannot upload one @tier0", async () => {
  const { athletes } = loadFixtures();
  const token = await apiLoginAs("CLUB_DELEGATE"); // scoped to club1

  const requirements = await api.get<{ data: { athleteId: string } }>(
    `/athletes/${athletes.club2}/requirements`,
    token
  );
  expect(requirements.data.athleteId).toBe(athletes.club2);

  const eligibility = await api.get<{ data: { athleteId: string } }>(
    `/athletes/${athletes.club2}/requirements/eligibility`,
    token
  );
  expect(eligibility.data.athleteId).toBe(athletes.club2);

  // Write actions stay club-scoped — this must still 403.
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("front", new Blob([bytes], { type: "image/png" }), "front.png");
  form.append("back", new Blob([bytes], { type: "image/png" }), "back.png");
  form.append("emissionDate", "2020-01-01");
  form.append("expirationDate", "2033-01-01");

  await expect(
    api.postMultipart(`/athletes/${athletes.club2}/requirements/identity-doc`, form, token)
  ).rejects.toMatchObject({ status: 403 } satisfies Partial<ApiError>);
});
