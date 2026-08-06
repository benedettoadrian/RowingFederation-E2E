import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";

// Fase 4.5 — athlete transfer between clubs. POST /athletes/:id/change-club
// is ADMIN/FEDERATION_ADMIN only. Asserts both the athlete's currentClubId
// AND the club-history invariants (old row closed, new row open) — the
// transfer response alone only proves the pointer moved, not that history
// was recorded correctly, which is the part actually worth auditing later
// (federation membership disputes, etc).

interface ClubHistoryEntry {
  id: string;
  clubId: string;
  startDate: string;
  endDate: string | null;
  isCurrentClub: boolean;
}

test("transferring an athlete updates currentClubId and closes/opens club history @tier0", async () => {
  const { clubs } = loadFixtures();
  const token = await apiLoginAs("ADMIN");

  const athlete = await api.post<{ data: { id: string; currentClubId: string } }>(
    "/athletes",
    {
      firstName: "Transfer",
      firstSurname: `Test${randomUUID().slice(0, 8)}`,
      gender: "MALE",
      birthdate: "2000-01-01",
      nationality: "UY",
      documentType: "PASSPORT",
      documentNumber: `T${randomUUID().slice(0, 8)}`,
      currentClubId: clubs.club1,
    },
    token
  );
  const athleteId = athlete.data.id;
  expect(athlete.data.currentClubId).toBe(clubs.club1);

  const transferred = await api.post<{ data: { currentClubId: string } }>(
    `/athletes/${athleteId}/change-club`,
    { newClubId: clubs.club2, transferReason: "E2E test transfer" },
    token
  );
  expect(transferred.data.currentClubId).toBe(clubs.club2);

  const history = await api.get<{ data: ClubHistoryEntry[] }>(
    `/athletes/${athleteId}/club-history`,
    token
  );

  const club1Entry = history.data.find((h) => h.clubId === clubs.club1);
  const club2Entry = history.data.find((h) => h.clubId === clubs.club2);

  expect(club1Entry?.endDate).not.toBeNull();
  expect(club1Entry?.isCurrentClub).toBe(false);
  expect(club2Entry?.endDate).toBeNull();
  expect(club2Entry?.isCurrentClub).toBe(true);
});
