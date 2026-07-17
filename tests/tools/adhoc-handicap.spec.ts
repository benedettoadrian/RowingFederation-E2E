import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loginAs, RoleKey } from "../../fixtures/auth.js";
import { api, ApiError } from "../../fixtures/lib/api.js";

/**
 * Ad-hoc handicap calculator tool (2026-07-16) — standalone, stateless
 * endpoint, no competition date/event/athlete needs to exist. Available to
 * any authenticated role (backend uses authMiddleware only, no requiresXxx
 * guard — verified against source), nothing is persisted besides an audit
 * log entry.
 */

function birthdateForAge(age: number): string {
  return `${new Date().getFullYear() - age}-01-01`;
}

test("any authenticated role can calculate — no role restriction on this tool @tier0", async () => {
  const roles: RoleKey[] = ["ADMIN", "REGATTA_COMMISSION", "REFEREE", "CLUB_DELEGATE", "PRESIDENT"];

  for (const role of roles) {
    const token = await apiLoginAs(role);
    const res = await api.post<{ success: boolean; data: Array<{ id: string; position: number | null }> }>(
      "/competitions/tools/calculate-adhoc-handicap",
      {
        crews: [
          {
            id: "crew-1",
            clubAbbreviation: "CNR",
            lane: "1",
            resultCode: "FINISHED",
            time: "4:00.00",
            rowers: [{ fullName: "Test Athlete", birthdate: birthdateForAge(50) }],
          },
        ],
      },
      token
    );
    expect(res.success).toBe(true);
    expect(res.data[0]).toMatchObject({ id: "crew-1", position: 1 });
  }
});

test("rejects an unauthenticated request @tier0", async () => {
  await expect(
    api.post(
      "/competitions/tools/calculate-adhoc-handicap",
      { crews: [{ id: "c1", clubAbbreviation: "CNR", resultCode: "FINISHED", time: "4:00.00", rowers: [{ fullName: "X", birthdate: "1990-01-01" }] }] }
    )
  ).rejects.toMatchObject({ status: 401 } satisfies Partial<ApiError>);
});

test("golden path: reproduces the FUR guide's 1XMM example (manually-entered crews, nothing persisted) @tier0", async () => {
  const token = await apiLoginAs("REFEREE");

  const res = await api.post<{ data: Array<{ id: string; handicapSeconds: number; officialTime: string; position: number }> }>(
    "/competitions/tools/calculate-adhoc-handicap",
    {
      crews: [
        { id: "poch", clubAbbreviation: "CNR", lane: "1", resultCode: "FINISHED", time: "4:25.96", rowers: [{ fullName: "Juan Poch", birthdate: birthdateForAge(53) }] },
        { id: "stenger", clubAbbreviation: "DRVM", lane: "2", resultCode: "FINISHED", time: "4:35.30", rowers: [{ fullName: "Walter Stenger", birthdate: birthdateForAge(52) }] },
        { id: "elola", clubAbbreviation: "CNR", lane: "3", resultCode: "FINISHED", time: "4:36.49", rowers: [{ fullName: "Andrés Elola", birthdate: birthdateForAge(63) }] },
      ],
    },
    token
  );

  const byId = Object.fromEntries(res.data.map((r) => [r.id, r]));
  expect(byId["poch"]).toMatchObject({ handicapSeconds: 1, officialTime: "4:24.96", position: 1 });
  expect(byId["stenger"]).toMatchObject({ handicapSeconds: 0, officialTime: "4:35.30", position: 3 });
  expect(byId["elola"]).toMatchObject({ handicapSeconds: 11, officialTime: "4:25.49", position: 2 });
});

test("rejects more than 20 crews @tier0", async () => {
  const token = await apiLoginAs("ADMIN");
  const crews = Array.from({ length: 21 }, (_, i) => ({
    id: `crew-${i}`,
    clubAbbreviation: "CNR",
    resultCode: "FINISHED",
    time: "4:00.00",
    rowers: [{ fullName: "Test Athlete", birthdate: "1990-01-01" }],
  }));

  await expect(
    api.post("/competitions/tools/calculate-adhoc-handicap", { crews }, token)
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("using the tool writes an audit log entry for the acting user, without persisting any crew data @tier0", async () => {
  const token = await apiLoginAs("REFEREE");
  const marker = randomUUID().slice(0, 8);

  await api.post(
    "/competitions/tools/calculate-adhoc-handicap",
    {
      crews: [
        {
          id: `marker-${marker}`,
          clubAbbreviation: "CNR",
          resultCode: "FINISHED",
          time: "4:00.00",
          rowers: [{ fullName: "Test Athlete", birthdate: "1990-01-01" }],
        },
      ],
    },
    token
  );

  // entityType is a fixed Prisma enum (USER/CLUB/ATHLETE/DOCUMENT/SYSTEM) —
  // there's no generic "tool" value, so the backend logs this as "system"
  // and puts the actual tool name in `changes` instead (verified against
  // prisma-audit-log.repository.ts's toAuditEntityType()). Fetch a small
  // batch and find the match rather than assuming index 0 — other SYSTEM-
  // category entries for this same pre-seeded REFEREE user could exist from
  // other tests sharing the role across the suite.
  const logs = await api.get<{
    data: { auditLogs: Array<{ action: string; entityType: string; changes: { tool?: string } }> };
  }>("/audit-logs/me?entityType=system&action=READ&limit=10", token);

  const match = logs.data.auditLogs.find((l) => l.changes?.tool === "adhoc-handicap-calculator");
  expect(match).toMatchObject({ action: "READ", entityType: "SYSTEM" });
});

test("editing and deleting a loaded crew before confirming the list works correctly (UI) @tier1", async ({
  page,
}) => {
  // Coverage gap found during manual review: every other test in this file
  // drives the calculate endpoint directly, none of them exercise the wizard
  // UI itself — so the edit/delete-before-confirm buttons in CrewListStep
  // had zero E2E coverage. This drives the real wizard end to end.
  const adminToken = await apiLoginAs("ADMIN");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const boatName = `E2E Adhoc UI ${suffix}`;

  await api.post(
    "/competitions/boats",
    {
      code: `1X${suffix}`,
      name: boatName,
      type: "SHELL",
      athleteCount: 1,
      hasCoxswain: false,
    },
    adminToken
  );

  await loginAs(page, "ADMIN");
  await page.goto("/es/tools/handicap-calculator");

  // Step 0 (added 2026-07-16): pick the calculation method before boat type.
  // Scoped to the method-step testid — both accordion headers below it also
  // contain "FUR"/"World Rowing (FISA)" as a substring of their own titles.
  await page.getByTestId("method-step").getByRole("button", { name: "FUR" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: boatName }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  const addCrew = async (club: string, name: string, birthdate: string) => {
    await page.getByRole("button", { name: "Agregar bote" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Sigla del club").fill(club);
    await dialog.getByLabel("Nombre completo").fill(name);
    await dialog.getByLabel("Fecha de nacimiento").fill(birthdate);
    await dialog.getByRole("button", { name: "Guardar bote" }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  };

  await addCrew("AAA", "Remero A", "1970-01-01");
  await addCrew("BBB", "Remero B", "1980-01-01");
  await addCrew("CCC", "Remero C", "1975-01-01");

  await expect(page.getByRole("row", { name: /AAA/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /BBB/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /CCC/ })).toBeVisible();

  // Edit the first crew's club abbreviation and confirm the change sticks.
  await page.getByRole("row", { name: /AAA/ }).getByRole("button", { name: "Editar" }).click();
  const editDialog = page.getByRole("dialog");
  const clubInput = editDialog.getByLabel("Sigla del club");
  await expect(clubInput).toHaveValue("AAA");
  await clubInput.fill("ZZZ");
  await editDialog.getByRole("button", { name: "Guardar bote" }).click();
  await expect(editDialog).toBeHidden({ timeout: 10_000 });

  await expect(page.getByRole("row", { name: /ZZZ/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /AAA/ })).toHaveCount(0);

  // Delete the throwaway crew — 2 crews remain, still satisfying MIN_CREWS.
  await page.getByRole("row", { name: /CCC/ }).getByRole("button", { name: "Eliminar" }).click();
  await expect(page.getByRole("row", { name: /CCC/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Confirmar lista" }).click();

  // The edit and the delete both carried through into the next step.
  await expect(page.getByRole("heading", { name: "Confirmar lista de botes" })).toBeVisible();
  await expect(page.getByRole("row", { name: /ZZZ/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /BBB/ })).toBeVisible();
  await expect(page.getByText("AAA", { exact: true })).toHaveCount(0);
  await expect(page.getByText("CCC", { exact: true })).toHaveCount(0);
});

/**
 * World Rowing (FISA) method (2026-07-16) — second calculation engine added
 * alongside FUR, still on the same stateless ad-hoc endpoint. New required
 * fields: method, boatClass, gender (once per session, not per crew).
 */
test("World Rowing golden path: reproduces the Federation's own worked example (M 1x, 50 vs 60 years) @tier0", async () => {
  const token = await apiLoginAs("REFEREE");

  const res = await api.post<{
    data: Array<{ id: string; handicapCentiseconds: number; predictedTimeCentiseconds: number; coefficientVersion: string }>;
  }>(
    "/competitions/tools/calculate-adhoc-handicap",
    {
      method: "WORLD_ROWING",
      boatClass: "1x",
      gender: "M",
      crews: [
        {
          id: "young",
          clubAbbreviation: "CNR",
          resultCode: "FINISHED",
          time: "4:00.00",
          rowers: [{ fullName: "Young Rower", birthdate: birthdateForAge(50), gender: "M" }],
        },
        {
          id: "old",
          clubAbbreviation: "DRVM",
          resultCode: "FINISHED",
          time: "4:00.00",
          rowers: [{ fullName: "Old Rower", birthdate: birthdateForAge(60), gender: "M" }],
        },
      ],
    },
    token
  );

  const byId = Object.fromEntries(res.data.map((r) => [r.id, r]));
  // "Ejemplo de cálculo" sheet: M 1x, 50 vs 60 years -> 9.167s difference,
  // explicitly contrasted against FUR's flat 10s for the same ages.
  const diffCentiseconds = byId["old"]!.handicapCentiseconds - byId["young"]!.handicapCentiseconds;
  expect(Math.abs(diffCentiseconds - 917)).toBeLessThanOrEqual(5);
  expect(byId["young"]!.coefficientVersion).toBe("WR_2026_03");
});

test("rejects Mixed gender with a boat class that has no official Mixed coefficients @tier0", async () => {
  const token = await apiLoginAs("ADMIN");

  await expect(
    api.post(
      "/competitions/tools/calculate-adhoc-handicap",
      {
        method: "WORLD_ROWING",
        boatClass: "2-", // coxless pair — Mixed only exists for 2x/4x/8+
        gender: "MIX",
        crews: [
          {
            id: "c1",
            clubAbbreviation: "CNR",
            resultCode: "FINISHED",
            time: "4:00.00",
            rowers: [
              { fullName: "A", birthdate: birthdateForAge(40), gender: "M" },
              { fullName: "B", birthdate: birthdateForAge(40), gender: "W" },
            ],
          },
        ],
      },
      token
    )
  ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
});

test("World Rowing calculation writes an audit log entry recording the method used @tier0", async () => {
  const token = await apiLoginAs("REFEREE");
  const marker = randomUUID().slice(0, 8);

  await api.post(
    "/competitions/tools/calculate-adhoc-handicap",
    {
      method: "WORLD_ROWING",
      boatClass: "1x",
      gender: "M",
      crews: [
        {
          id: `marker-${marker}`,
          clubAbbreviation: "CNR",
          resultCode: "FINISHED",
          time: "4:00.00",
          rowers: [{ fullName: "Test Athlete", birthdate: "1990-01-01", gender: "M" }],
        },
      ],
    },
    token
  );

  const logs = await api.get<{
    data: { auditLogs: Array<{ action: string; entityType: string; changes: { tool?: string; method?: string } }> };
  }>("/audit-logs/me?entityType=system&action=READ&limit=10", token);

  const match = logs.data.auditLogs.find((l) => l.changes?.tool === "adhoc-handicap-calculator" && l.changes?.method);
  expect(match).toMatchObject({ action: "READ", entityType: "SYSTEM", changes: { method: "WORLD_ROWING" } });
});

test("World Rowing method end to end through the wizard UI, including per-rower gender @tier1", async ({ page }) => {
  const adminToken = await apiLoginAs("ADMIN");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const boatName = `E2E Adhoc WR ${suffix}`;

  await api.post(
    "/competitions/boats",
    {
      code: `1X${suffix}`,
      name: boatName,
      type: "SHELL",
      athleteCount: 1,
      hasCoxswain: false,
    },
    adminToken
  );

  await loginAs(page, "ADMIN");
  await page.goto("/es/tools/handicap-calculator");

  // Scoped to the method-step testid — the accordion header below it also
  // contains "World Rowing (FISA)" as a substring of its own title.
  await page.getByTestId("method-step").getByRole("button", { name: "World Rowing (FISA)" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  await page.getByRole("button", { name: "Masculino" }).click();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: boatName }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  const addCrew = async (club: string, name: string, birthdate: string) => {
    await page.getByRole("button", { name: "Agregar bote" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Sigla del club").fill(club);
    await dialog.getByLabel("Nombre completo").fill(name);
    await dialog.getByLabel("Fecha de nacimiento").fill(birthdate);
    await dialog.getByRole("button", { name: "M", exact: true }).click();
    await dialog.getByRole("button", { name: "Guardar bote" }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  };

  await addCrew("WRA", "Remero Joven", "1975-01-01");
  await addCrew("WRB", "Remero Mayor", "1965-01-01");

  await page.getByRole("button", { name: "Confirmar lista" }).click();
  await page.getByRole("button", { name: "Confirmar y continuar" }).click();

  await page.getByRole("row", { name: /WRA/ }).getByPlaceholder("7:23.45").fill("4:00.00");
  await page.getByRole("row", { name: /WRB/ }).getByPlaceholder("7:23.45").fill("4:00.00");
  await page.getByRole("button", { name: "Calcular" }).click();

  await expect(page.getByRole("heading", { name: "Resultado" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("row", { name: /WRA/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /WRB/ })).toBeVisible();

  // Grid's "Hándicap" column reads handicapSeconds (FUR-only field) with no
  // fallback to handicapCentiseconds — regression check for a bug where World
  // Rowing rows silently showed "—" here (handicapSeconds is always null for
  // WR) even though the calculation itself was correct end to end.
  const handicapCell = page.getByRole("row", { name: /WRB/ }).locator("td").nth(7);
  await expect(handicapCell).not.toHaveText("—");
  await expect(handicapCell).toHaveText(/\d+\.\d{2}s/);

  // Older crew gets a bigger handicap under World Rowing too — different
  // formula from FUR, but same direction: older ages compensate more.
  await page.getByRole("button", { name: "Ver detalle del cálculo" }).click();
  await expect(page.getByText("World Rowing (FISA)").first()).toBeVisible();

  // Reference curve chart: the full theoretical curve (fetched from
  // GET /world-rowing-curve) renders as a background line, this race's own
  // crews render as marked dots on top of it, and both loaded boats are
  // listed by name underneath — not just the couple of crews connected by a
  // straight line (the old, pre-curve-endpoint version of this chart).
  await expect(page.getByText("Botes cargados en esta carrera")).toBeVisible();
  await expect(page.getByText(/WRA.*edad 51/)).toBeVisible();
  await expect(page.getByText(/WRB.*edad 61/)).toBeVisible();
  await expect(page.locator(".recharts-scatter-symbol")).toHaveCount(2);
  await expect(page.locator(".recharts-line")).toHaveCount(1);
});
