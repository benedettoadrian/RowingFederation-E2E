import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { withDb } from "./lib/db.js";
import { FIXTURE_PASSWORD } from "./lib/config.js";

export const BOOTSTRAP_ADMIN_EMAIL = "admin@e2e.test";

/**
 * Inserts a single ADMIN user directly into Postgres, bypassing the app
 * entirely (bcrypt rounds = 10 to match
 * src/modules/users/infrastructure/services/bcrypt-password-hasher.service.ts
 * exactly — a different round count would still hash successfully but is
 * worth keeping honest since it's the one thing here NOT going through the
 * real app). isActive/emailVerified are set true directly since there's no
 * verification-email flow to complete in the test stack.
 *
 * Idempotent: safe to run against an already-seeded DB (upserts on email).
 */
export async function bootstrapAdmin(): Promise<void> {
  const hashed = await bcrypt.hash(FIXTURE_PASSWORD, 10);

  await withDb(async (client) => {
    await client.query(
      `
      INSERT INTO users (
        id, email, password, "emailVerified", "firstName", "lastName",
        gender, birthdate, roles, "isActive", "lastPasswordChange",
        "mustResetPassword", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, true, 'E2E', 'Admin',
        'MALE', '1990-01-01', ARRAY['ADMIN']::"UserRole"[], true, now(),
        false, now(), now()
      )
      ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password
      `,
      [randomUUID(), BOOTSTRAP_ADMIN_EMAIL, hashed]
    );
  });
}
