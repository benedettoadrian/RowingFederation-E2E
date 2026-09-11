import { Client } from "pg";
import { LOCAL_DB_URL } from "../config.js";

/**
 * Raw Postgres access for this simulation's Fase 0 (read-only recipe
 * extraction + expected-value calculations). Never used to write business
 * data — every state-changing step of the simulation happens through the
 * real UI (see plan.md, "Diseño técnico del script").
 */
export async function withLocalDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
