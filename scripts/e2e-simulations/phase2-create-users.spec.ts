import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  SIM_PASSWORD,
  SIM_REGATTA_COMMISSION_EMAIL,
  SIM_REFEREE_EMAIL,
  SIM_REFEREE_2_EMAIL,
  SIM_EMAIL_DOMAIN,
  simDelegateEmail,
} from "./config.js";
import { SIM_BOOTSTRAP_ADMIN_EMAIL } from "./bootstrap-admin.js";
import { simLogin, readState, writeState } from "./lib/ui.js";
import { withLocalDb } from "./lib/db.js";

/**
 * Fase 2 of plan.md (full scope: pilot delegate + 2.1's full rollout merged
 * into one test/one video) — REGATTA_COMMISSION, both REFEREEs, and one
 * delegate per real club (Club Nacional de Regatas plus every remaining
 * club; FUR/atleta libre never needs one — created directly by ADMIN in
 * Fecha 3, confirmed via crew_entries.createdById, see plan.md).
 *
 * Idempotent per Fase 0.6/D6: searches `/es/users` by email before ever
 * creating — a re-run finds what a previous run made and reuses it instead
 * of hitting a duplicate-email error. Handles the "cupos llenos, quitar
 * delegado" branch (D6) for clubs where both slots are occupied by real,
 * non-e2e-sim users (Colonia/Salto): frees the SECONDARY slot via the real
 * "Quitar delegado" action on /clubs/[id] — never touches the PRIMARY slot,
 * never resets anyone's password.
 */
interface Recipe {
  clubs: { clubId: string; clubName: string; slug: string }[];
}
const recipe: Recipe = JSON.parse(
  readFileSync(new URL("./output/recipe.json", import.meta.url), "utf8")
);
const clubNacionalId = "YY5rcEFFYMkMbqn3Xa2RB";
const clubNacional = recipe.clubs.find((c) => c.clubId === clubNacionalId)!;
const FUR_ID = "846d4ed9-dfe2-4bd1-8647-14114b7a23d9";
const ALREADY_HANDLED_SEPARATELY = new Set([clubNacionalId, FUR_ID]);

/** Searches /es/users by email; returns the existing user's detail URL, or null if not found. */
async function findUserByEmail(page: Page, email: string): Promise<string | null> {
  await page.goto("/es/users");
  await page.getByPlaceholder("Buscar usuarios...").fill(email);
  // useDebounce is 300ms (users/page.tsx) + one refetch round trip.
  await page.waitForTimeout(600);
  const row = page.locator("tr", { hasText: email });
  if ((await row.count()) === 0) return null;
  await row.getByRole("link", { name: "Ver detalle" }).click();
  await page.waitForURL(/\/es\/users\/[^/]+$/, { timeout: 10_000 });
  return page.url();
}

async function createUser(
  page: Page,
  opts: {
    firstName: string;
    lastName: string;
    email: string;
    roleLabel: string;
    clubLabel?: string;
  }
) {
  await page.goto("/es/users/new");
  await page.getByLabel("Nombre").fill(opts.firstName);
  await page.getByLabel("Apellido").fill(opts.lastName);
  await page.getByLabel("Género").click();
  await page.getByRole("option", { name: "Masculino" }).click();
  await page.getByLabel("Fecha de nacimiento").fill("1990-01-01");
  await page.getByLabel("Rol").click();
  await page.getByRole("option", { name: opts.roleLabel, exact: true }).click();
  if (opts.clubLabel) {
    await page.getByLabel("Club *").click();
    await page.getByRole("option", { name: opts.clubLabel, exact: true }).click();
  }
  await page.getByLabel("Correo electrónico").fill(opts.email);
  await page.getByLabel("Contraseña *").fill(SIM_PASSWORD);
  await page.getByRole("button", { name: "Crear usuario" }).click();
  // Success redirects to /es/users/{id} — more robust than racing the toast,
  // which can disappear before this assertion runs.
  await page.waitForURL(/\/es\/users\/[^/]+$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(opts.firstName);
}

async function findOrCreateUser(
  page: Page,
  opts: Parameters<typeof createUser>[1]
): Promise<{ existed: boolean }> {
  const existingUrl = await findUserByEmail(page, opts.email);
  if (existingUrl) {
    console.log(`  reused existing user: ${opts.email}`);
    return { existed: true };
  }
  await createUser(page, opts);
  console.log(`  created new user: ${opts.email}`);
  return { existed: false };
}

/** Checks (read-only) whether both delegate slots on a club are occupied by non-e2e-sim users. */
async function bothSlotsOccupiedByOthers(clubId: string): Promise<boolean> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      `SELECT u1.email AS d1, u2.email AS d2 FROM clubs c
       LEFT JOIN users u1 ON u1.id = c."currentDelegateId"
       LEFT JOIN users u2 ON u2.id = c."secondDelegateId"
       WHERE c.id = $1`,
      [clubId]
    );
    const row = res.rows[0];
    if (!row) return false;
    const isOurs = (email: string | null) => !!email && email.includes(SIM_EMAIL_DOMAIN);
    return !!row.d1 && !!row.d2 && !isOurs(row.d1) && !isOurs(row.d2);
  });
}

async function freeSecondaryDelegateSlot(page: Page, clubId: string) {
  await page.goto(`/es/clubs/${clubId}`);
  // Structural selector (DelegateSlot.tsx JSX): the "Segundo delegado" label
  // sits in a `<div className="flex items-start ...">` row alongside a
  // 2-button group — "Cambiar" first, the icon-only "remove" button second.
  // CSS-class-based selectors (.text-destructive) turned out unreliable
  // here; button order is a direct fact from the component's own source.
  const secondaryRow = page
    .getByText("Segundo delegado", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'items-start')][1]");
  await secondaryRow.getByRole("button").last().click();
  await page.getByRole("button", { name: "Remover", exact: true }).click();
  await expect(page.getByText("Sin delegado asignado")).toBeVisible({ timeout: 10_000 });
}

test("Fase 2 — usuarios de prueba y delegados por club (piloto + escalado completo)", async ({ page }) => {
  await simLogin(page, SIM_BOOTSTRAP_ADMIN_EMAIL, SIM_PASSWORD);

  await test.step("Comisión de Regatas de prueba", async () => {
    await findOrCreateUser(page, {
      firstName: "E2E-SIM",
      lastName: "Comision",
      email: SIM_REGATTA_COMMISSION_EMAIL,
      roleLabel: "Comisión de Regatas",
    });
  });

  await test.step("Referí de prueba (futuro presidente de fecha)", async () => {
    await findOrCreateUser(page, {
      firstName: "E2E-SIM",
      lastName: "Referee",
      email: SIM_REFEREE_EMAIL,
      roleLabel: "Árbitro",
    });
  });

  await test.step("Segundo referí de prueba (carga resultados, no es el presidente)", async () => {
    await findOrCreateUser(page, {
      firstName: "E2E-SIM",
      lastName: "Referee Dos",
      email: SIM_REFEREE_2_EMAIL,
      roleLabel: "Árbitro",
    });
  });

  const delegatesByClubId: Record<string, { email: string; wasCreated: boolean }> = {
    ...readState().delegatesByClubId,
  };

  const delegateEmail = simDelegateEmail(clubNacional.slug);
  await test.step(`Delegado de ${clubNacional.clubName}`, async () => {
    const { existed } = await findOrCreateUser(page, {
      firstName: "E2E-SIM",
      lastName: `Delegado ${clubNacional.clubName}`,
      email: delegateEmail,
      roleLabel: "Delegado de Club",
      clubLabel: clubNacional.clubName,
    });
    delegatesByClubId[clubNacionalId] = { email: delegateEmail, wasCreated: !existed };
  });

  const remainingClubs = recipe.clubs.filter((c) => !ALREADY_HANDLED_SEPARATELY.has(c.clubId));
  await test.step(`Delegados de los ${remainingClubs.length} clubes restantes`, async () => {
    for (const club of remainingClubs) {
      const email = simDelegateEmail(club.slug);
      const existed = await findUserByEmail(page, email);

      if (existed) {
        console.log(`  reused existing delegate: ${email}`);
        delegatesByClubId[club.clubId] = { email, wasCreated: false };
        continue;
      }

      if (await bothSlotsOccupiedByOthers(club.clubId)) {
        console.log(`  ${club.clubName}: both delegate slots full of non-e2e-sim users — freeing secondary slot`);
        await freeSecondaryDelegateSlot(page, club.clubId);
      }

      await createUser(page, {
        firstName: "E2E-SIM",
        lastName: `Delegado ${club.clubName}`,
        email,
        roleLabel: "Delegado de Club",
        clubLabel: club.clubName,
      });
      console.log(`  created new delegate: ${email}`);
      delegatesByClubId[club.clubId] = { email, wasCreated: true };
    }
  });

  writeState({
    regattaCommissionEmail: SIM_REGATTA_COMMISSION_EMAIL,
    refereeEmail: SIM_REFEREE_EMAIL,
    delegatesByClubId,
  });
  console.log(`Delegates ready for ${1 + remainingClubs.length} clubs.`);
});
