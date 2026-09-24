import { test, expect } from "@playwright/test";
import { apiLoginAs, loginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";
import { setupInscriptionFixtures } from "../../fixtures/lib/competitions.js";

/**
 * "The official program is out" banner — shown on the public home page and
 * every authenticated dashboard for the nearest upcoming CompetitionDate in
 * status CLOSED (sorteo confirmed, program locked, hasn't started yet).
 * Federation directive 2026-09-24.
 */

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

async function loginApi(email: string, password: string): Promise<string> {
  const res = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

test("shows the official program banner, on the public home page and every authenticated dashboard, only while the date is CLOSED @tier0", async ({
  page,
}) => {
  const regattaToken = await apiLoginAs("REGATTA_COMMISSION");
  const adminToken = await apiLoginAs("ADMIN");
  const { credentials } = loadFixtures();

  // The banner shows the globally NEAREST upcoming CLOSED date — the
  // fixture's default date is randomly spread across ~1370 years (birthday-
  // paradox mitigation for CompetitionDate.date's DB-wide uniqueness, see
  // competitionDatePayload's comment), which would make "is MY date the one
  // shown" a coin flip against whatever other CLOSED-transitioning test
  // happens to run in the same suite invocation. Pinned to 5 days out —
  // comfortably below the random range's 30-day floor — to make this
  // deterministic instead. inscriptionOpenAt/CloseAt overridden alongside it
  // to stay consistent (they're otherwise computed from the random date).
  // +5..+24 days: comfortably below the 30-day floor, with enough day-level
  // spread that re-running this test within the same day doesn't collide
  // with itself on CompetitionDate.date's DB-wide uniqueness.
  const soon = new Date();
  soon.setUTCDate(soon.getUTCDate() + 5 + Math.floor(Math.random() * 20));
  soon.setUTCHours(0, 0, 0, 0);
  const inscriptionOpenAt = new Date();
  inscriptionOpenAt.setUTCDate(inscriptionOpenAt.getUTCDate() + 1);
  const inscriptionCloseAt = new Date(soon);
  inscriptionCloseAt.setUTCDate(inscriptionCloseAt.getUTCDate() - 1);
  inscriptionCloseAt.setUTCHours(23, 0, 0, 0);

  const fx = await setupInscriptionFixtures(regattaToken, {
    dateOverrides: {
      date: soon.toISOString(),
      inscriptionOpenAt: inscriptionOpenAt.toISOString(),
      inscriptionCloseAt: inscriptionCloseAt.toISOString(),
      refereePresidentId: credentials.REFEREE.userId,
    },
  });
  const club1Token = await loginApi(fx.club1.delegateEmail, fx.club1.delegatePassword);
  const competitionDateName = (
    await api.get<{ data: { name: string } }>(
      `/competitions/competition-dates/${fx.competitionDateId}`,
      regattaToken
    )
  ).data.name;

  const inscribed = await inscribe(
    fx.competitionDateId,
    fx.eventId,
    fx.club1Id,
    fx.club1.athleteId,
    club1Token
  );

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
      crewChangeWindowOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
      crewChangeWindowClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    regattaToken
  );

  // Before CLOSED: banner absent on the public home page.
  await page.goto("/es");
  await expect(page.getByTestId("official-program-banner")).not.toBeVisible();

  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "CLOSED" },
    regattaToken
  );

  // Public home page — no login. Scoped to the banner itself: the
  // competition name can legitimately also appear elsewhere on the page
  // (e.g. the "next competition" stat cell), so an unscoped text locator
  // would be ambiguous.
  await page.goto("/es");
  const publicBanner = page.getByTestId("official-program-banner");
  await expect(publicBanner).toBeVisible();
  await expect(publicBanner.getByText("Programa oficial disponible")).toBeVisible();
  await expect(publicBanner.getByText(competitionDateName)).toBeVisible();
  const publicCta = publicBanner.getByRole("link", { name: /Ver programa oficial/i });
  await expect(publicCta).toBeVisible();
  await expect(publicCta).toHaveAttribute("href", `/es/calendario/${fx.competitionDateId}`);

  // Authenticated dashboard — CLUB_DELEGATE, deliberately a role with its
  // own exclusive dashboard branch, to prove the banner renders for every
  // role, not just admin-adjacent ones.
  await loginAs(page, "CLUB_DELEGATE");
  await page.goto("/es/dashboard");
  const dashboardBanner = page.getByTestId("official-program-banner");
  await expect(dashboardBanner).toBeVisible();
  await expect(dashboardBanner.getByText("Programa oficial disponible")).toBeVisible();
  const dashboardCta = dashboardBanner.getByRole("link", { name: /Ver programa oficial/i });
  await expect(dashboardCta).toHaveAttribute(
    "href",
    `/es/competitions/dates/${fx.competitionDateId}/program`
  );

  // Once the date moves past CLOSED (competition started), the banner is
  // gone — it's not "próxima a competir" anymore. Manually starting a
  // competition (CLOSED -> IN_COMPETITION) requires ADMIN specifically,
  // unlike the earlier transitions.
  await api.patch(
    `/competitions/competition-dates/${fx.competitionDateId}/status`,
    { status: "IN_COMPETITION" },
    adminToken
  );
  await page.goto("/es/dashboard");
  await expect(page.getByTestId("official-program-banner")).not.toBeVisible();
});
