import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";

/**
 * Institutional Documents module, redefined 2026-07 (Acta/Estatuto/
 * Reglamento/Manual — the previous category/accessLevel design was never
 * used in production, 0 rows). Covers the acceptance criteria agreed for
 * the redesign: publish-only-by-admin, no role restriction on
 * Acta/Estatuto/Reglamento, per-role scoping + admin-sees-all on Manual,
 * version chaining, and the MANUAL-must-be-HTML / others-must-not rule.
 */

const PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");
const HTML_CONTENT = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>content</p></body></html>`;

function pngForm(fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  form.append("document", new Blob([PNG_BYTES], { type: "image/png" }), "file.png");
  appendFields(form, fields);
  return form;
}

function htmlForm(content: string, fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  form.append("document", new Blob([content], { type: "text/html" }), "manual.html");
  appendFields(form, fields);
  return form;
}

function appendFields(form: FormData, fields: Record<string, string | string[]>) {
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) form.append(key, v);
    } else {
      form.append(key, value);
    }
  }
}

test.describe("Institutional Documents — Acta/Estatuto/Reglamento", () => {
  test("ADMIN can publish a REGLAMENTO and re-publish a new version on the same slug", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const slug = `reglamento-test-${randomUUID().slice(0, 8)}`;

    const v1 = await api.postMultipart<{ data: { id: string; version: number } }>(
      "/documents",
      pngForm({ title: "Reglamento de Regatas", section: "REGLAMENTO", slug }),
      adminToken
    );
    expect(v1.data.version).toBe(1);

    const v2 = await api.postMultipart<{ data: { id: string; version: number } }>(
      "/documents",
      pngForm({ title: "Reglamento de Regatas", section: "REGLAMENTO", slug, changelog: "v2 update" }),
      adminToken
    );
    expect(v2.data.version).toBe(2);

    const versions = await api.get<{ data: Array<{ id: string; version: number; isLatestVersion: boolean }> }>(
      `/documents/by-slug/${slug}/versions`,
      adminToken
    );
    expect(versions.data).toHaveLength(2);
    const latest = versions.data.find((v) => v.id === v2.data.id);
    const previous = versions.data.find((v) => v.id === v1.data.id);
    expect(latest?.isLatestVersion).toBe(true);
    expect(previous?.isLatestVersion).toBe(false);

    const current = await api.get<{ data: { id: string; version: number } }>(
      `/documents/by-slug/${slug}`,
      adminToken
    );
    expect(current.data.id).toBe(v2.data.id);
  });

  test("ACTA does not chain versions — each publish is independent", async () => {
    const adminToken = await apiLoginAs("ADMIN");

    const acta1 = await api.postMultipart<{ data: { id: string; version: number; slug?: string } }>(
      "/documents",
      pngForm({ title: `Acta ${randomUUID().slice(0, 8)}`, section: "ACTA" }),
      adminToken
    );
    expect(acta1.data.version).toBe(1);
    expect(acta1.data.slug ?? null).toBeNull();
  });

  test("non-admin roles cannot publish a document", async () => {
    const delegateToken = await apiLoginAs("CLUB_DELEGATE");

    await expect(
      api.postMultipart(
        "/documents",
        pngForm({ title: "Intento no autorizado", section: "REGLAMENTO", slug: `nope-${randomUUID().slice(0, 6)}` }),
        delegateToken
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  test("any authenticated Gestión role can read Acta/Estatuto/Reglamento (no role scoping)", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const slug = `estatuto-test-${randomUUID().slice(0, 8)}`;
    await api.postMultipart(
      "/documents",
      pngForm({ title: "Estatuto FUR", section: "ESTATUTO", slug }),
      adminToken
    );

    const refereeToken = await apiLoginAs("REFEREE");
    const asReferee = await api.get<{ data: { slug: string } }>(`/documents/by-slug/${slug}`, refereeToken);
    expect(asReferee.data.slug).toBe(slug);
  });
});

test.describe("Institutional Documents — Manuales (role-scoped)", () => {
  test("a role only sees manuals targeting it; ADMIN sees every manual regardless", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const slug = `manual-referee-${randomUUID().slice(0, 8)}`;

    await api.postMultipart(
      "/documents",
      htmlForm(HTML_CONTENT("Manual Árbitro"), {
        title: "Manual del Árbitro",
        section: "MANUAL",
        slug,
        targetRoles: ["REFEREE"],
      }),
      adminToken
    );

    // Target role sees it.
    const refereeToken = await apiLoginAs("REFEREE");
    const asReferee = await api.get<{ data: { slug: string } }>(`/documents/by-slug/${slug}`, refereeToken);
    expect(asReferee.data.slug).toBe(slug);

    // A different, non-targeted role does not — consistent with the
    // existing GET /documents/:id convention, access-denied maps to 403,
    // not 404 (see document.controller.ts's throwMappedError).
    const commissionToken = await apiLoginAs("REGATTA_COMMISSION");
    await expect(
      api.get(`/documents/by-slug/${slug}`, commissionToken)
    ).rejects.toMatchObject({ status: 403 });

    // ADMIN sees it too, despite not being in targetRoles.
    const asAdmin = await api.get<{ data: { slug: string } }>(`/documents/by-slug/${slug}`, adminToken);
    expect(asAdmin.data.slug).toBe(slug);
  });

  test("a user holding multiple roles sees every manual matching any of them", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);

    const refereeSlug = `manual-multi-referee-${suffix}`;
    const commissionSlug = `manual-multi-commission-${suffix}`;

    await api.postMultipart(
      "/documents",
      htmlForm(HTML_CONTENT("Manual Árbitro"), {
        title: "Manual del Árbitro",
        section: "MANUAL",
        slug: refereeSlug,
        targetRoles: ["REFEREE"],
      }),
      adminToken
    );
    await api.postMultipart(
      "/documents",
      htmlForm(HTML_CONTENT("Manual Comisión"), {
        title: "Manual de la Comisión de Regatas",
        section: "MANUAL",
        slug: commissionSlug,
        targetRoles: ["REGATTA_COMMISSION"],
      }),
      adminToken
    );

    // A fresh user, created with a single role then given a second one —
    // mirrors a real board member who also referees.
    const email = `multi-role-${suffix}@e2e.test`;
    const password = "E2eTest123";
    const created = await api.post<{ data: { id: string } }>(
      "/users",
      {
        email,
        password,
        firstName: "Multi",
        lastName: "Role",
        birthDate: "1985-01-01",
        gender: "MALE",
        role: "REGATTA_COMMISSION",
      },
      adminToken
    );

    await api.post(
      `/users/${created.data.id}/assign-role`,
      { roles: ["REGATTA_COMMISSION", "REFEREE"] },
      adminToken
    );

    const login = await api.post<{ data: { accessToken: string } }>("/auth/login", { email, password });
    const multiRoleToken = login.data.accessToken;

    const refereeManual = await api.get<{ data: { slug: string } }>(
      `/documents/by-slug/${refereeSlug}`,
      multiRoleToken
    );
    expect(refereeManual.data.slug).toBe(refereeSlug);

    const commissionManual = await api.get<{ data: { slug: string } }>(
      `/documents/by-slug/${commissionSlug}`,
      multiRoleToken
    );
    expect(commissionManual.data.slug).toBe(commissionSlug);

    // And the list endpoint returns both when filtered to MANUAL.
    const list = await api.get<{ data: Array<{ slug: string }> }>(
      `/documents?section=MANUAL&limit=100`,
      multiRoleToken
    );
    const slugs = list.data.map((d) => d.slug);
    expect(slugs).toContain(refereeSlug);
    expect(slugs).toContain(commissionSlug);
  });
});

test.describe("Institutional Documents — file type enforcement", () => {
  test("MANUAL must be uploaded as HTML", async () => {
    const adminToken = await apiLoginAs("ADMIN");

    await expect(
      api.postMultipart(
        "/documents",
        pngForm({
          title: "Manual inválido",
          section: "MANUAL",
          slug: `manual-invalid-${randomUUID().slice(0, 6)}`,
          targetRoles: ["REFEREE"],
        }),
        adminToken
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  test("REGLAMENTO/ESTATUTO/ACTA cannot be uploaded as HTML", async () => {
    const adminToken = await apiLoginAs("ADMIN");

    await expect(
      api.postMultipart(
        "/documents",
        htmlForm(HTML_CONTENT("No debería entrar"), {
          title: "Reglamento inválido",
          section: "REGLAMENTO",
          slug: `reglamento-invalid-${randomUUID().slice(0, 6)}`,
        }),
        adminToken
      )
    ).rejects.toMatchObject({ status: 400 });
  });
});
