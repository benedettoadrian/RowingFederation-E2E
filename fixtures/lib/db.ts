import { Client } from "pg";
import { DB_URL } from "./config.js";

/**
 * Raw Postgres access — used ONLY to bootstrap the very first ADMIN user
 * (there is no way to create a user through the real API without already
 * being authenticated as an admin). Every other fixture is created through
 * the real HTTP API (see seed.ts) so the seed itself exercises the same
 * code path production traffic does.
 *
 * Column names match prisma/schema.prisma in RowingFederation-Backend
 * exactly (no @map directives on User at the time this was written — if
 * that schema changes, this needs to change with it).
 */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
