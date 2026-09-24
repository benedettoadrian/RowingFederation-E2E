import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * Regression (2026-09-24): CLUB_DELEGATE got a 403 opening "Programa
 * Oficial" (/competitions/dates/[id]/program) because the page fetched
 * crew entries through the restricted /crew-entries/all endpoint instead of
 * the public one. Fixed by switching the page to usePublicInscriptions
 * (/crew-entries/public — no role restriction, gated only by
 * CompetitionDate.status per get-public-inscriptions.use-case.ts). This
 * covers the page itself; official-program-banner.spec.ts covers the
 * separate "program is out" banner that links here.
 */

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

async function inscribe(
  competitionDateId: string,
  eventId: string,
  clubId: string,
  athleteId: string,
  token: string
) {
  return api.post<{ data: { id: string } }>(
    "/competitions/crew-entries",
    { competitionDateId, eventId, clubId, members: [{ athleteId, role: "ROWER" }] },
    token
  );
}

test("CLUB_DELEGATE can open the official program of a CLOSED date and sees its content, not a blank/error screen @tier0", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const fx = await setupInscriptionFixtures(regattaToken);
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);

  const inscribed = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );

  // ALLOWED_STATUSES for this page is CLOSED/IN_COMPETITION/FINAL_RESULTS
  // (program/page.tsx) — CLOSED is the one reachable via a real sorteo, same
  // sequence as official-program-banner.spec.ts.
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_REVIEW" },
    regattaToken
  );
  await api.post(
    `/competitions/competition-dates/${fx.competitionDateId}/sorteo/confirm`,
    { assignments: [{ entryId: inscribed.data.id, series: "Final", lane: 1 }] },
    regattaToken
  );
  await api.put(
    `/competitions/competition-dates/${fx.competitionDateId}`,
    {
      refereePresidentId: fx.referee.userId,
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  const eventName = (
    await api.get<{ data: { name: string } }>(`/competitions/events/${fx.eventId}`, regattaToken)
  ).data.name;
  const club1Name = (
    await api.get<{ data: { name: string } }>(`/clubs/${fx.club1Id}`, regattaToken)
  ).data.name;

  await loginAs(page, "CLUB_DELEGATE");
  await page.goto(`/es/competitions/dates/${fx.competitionDateId}/program`);

  // Regression guard, not just "no 403": the old restricted-endpoint bug
  // surfaced as "program.loadError" ("Error al cargar el programa
  // oficial.") in entriesError branch of program/page.tsx, not a hard
  // navigation error — assert it's absent AND that the real prueba/boat
  // content rendered, so a silently-blank page can't pass either.
  await expect(page.getByText("Error al cargar el programa oficial.")).not.toBeVisible();
  await expect(page.getByText(eventName.toUpperCase())).toBeVisible();
  await expect(page.getByText(club1Name)).toBeVisible();
});
