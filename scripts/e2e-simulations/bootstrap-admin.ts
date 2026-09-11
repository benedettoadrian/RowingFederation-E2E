import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { withLocalDb } from "./lib/db.js";
import { SIM_PASSWORD, SIM_EMAIL_DOMAIN } from "./config.js";

export const SIM_BOOTSTRAP_ADMIN_EMAIL = `e2e-sim.bootstrap-admin@${SIM_EMAIL_DOMAIN}`;

/**
 * Fase 0.7 of plan.md. Mirrors the exact, already-established precedent in
 * this repo (fixtures/bootstrap-admin.ts, used for the Docker E2E stack):
 * inserting a user directly via SQL is normally forbidden by this
 * simulation's "everything through the real UI" rule, but there is a real
 * chicken-and-egg problem at the very start — creating ANY user through the
 * UI (Fase 2) requires an already-authenticated ADMIN session, and we don't
 * know the real local-dev ADMIN's password (it's the developer's own
 * personal account, never to be touched/reset by this script). So exactly
 * one bootstrap ADMIN, under our own e2e-sim.* naming convention, is
 * inserted directly — a single, narrow, documented exception, identical in
 * spirit to the one already accepted in fixtures/bootstrap-admin.ts.
 *
 * bcrypt rounds = 10, matching RowingFederation-Backend
 * src/modules/users/infrastructure/services/bcrypt-password-hasher.service.ts
 * exactly. Idempotent (ON CONFLICT DO UPDATE) so re-runs never duplicate it
 * — this IS the "usuario propio del script, buscar antes de crear" pattern
 * from Fase 0.6, just applied via upsert instead of a UI search because
 * there is no UI action available yet at this point in a fresh run.
 *
 * Counts toward R-ROLE-001 (max 3 active ADMIN) — 1 real admin exists
 * today, so this fits with room to spare.
 */
export async function bootstrapSimAdmin(): Promise<void> {
  const hashed = await bcrypt.hash(SIM_PASSWORD, 10);

  await withLocalDb(async (client) => {
    await client.query(
      `
      INSERT INTO users (
        id, email, password, "emailVerified", "firstName", "lastName",
        gender, birthdate, roles, "isActive", "lastPasswordChange",
        "mustResetPassword", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, true, 'E2E-SIM', 'Bootstrap Admin',
        'MALE', '1990-01-01', ARRAY['ADMIN']::"UserRole"[], true, now(),
        false, now(), now()
      )
      ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password
      `,
      [randomUUID(), SIM_BOOTSTRAP_ADMIN_EMAIL, hashed]
    );
  });

  console.log(`Bootstrap ADMIN ready: ${SIM_BOOTSTRAP_ADMIN_EMAIL}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  bootstrapSimAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
