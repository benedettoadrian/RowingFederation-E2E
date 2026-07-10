import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs, loadFixtures } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";

/**
 * Fase 8.5 — audit trail, as one dedicated test rather than retrofitting
 * an assertion into every write test across Fases 3-6 (lower risk of
 * breaking already-green tests; still proves the audit pipeline works end
 * to end for a representative write). GET /audit-logs/entity/:type/:id.
 */

test("creating a club produces an audit log entry with the correct actor and action @tier0", async () => {
  const adminToken = await apiLoginAs("ADMIN");
  const { credentials } = loadFixtures();

  const club = await api.post<{ data: { id: string } }>(
    "/clubs",
    {
      name: `Club Audit ${randomUUID().slice(0, 8)}`,
      abbreviation: randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase(),
      addressCountry: "Uruguay",
      addressState: "Montevideo",
      addressCity: "Montevideo",
      addressStreet: "Rambla Sur 123",
      addressPostalCode: "11000",
      email: `club-audit-${randomUUID().slice(0, 8)}@e2e.test`,
      foundationDate: "1950-01-01",
      affiliationDate: "1950-01-01",
    },
    adminToken
  );

  const logs = await api.get<{
    data: { auditLogs: Array<{ action: string; entityType: string; userId: string }> };
  }>(`/audit-logs/entity/Club/${club.data.id}`, adminToken);

  const createLog = logs.data.auditLogs.find((l) => l.action === "CREATE");
  expect(createLog).toBeDefined();
  expect(createLog?.entityType).toBe("CLUB");
  expect(createLog?.userId).toBe(credentials.ADMIN.userId);
});
