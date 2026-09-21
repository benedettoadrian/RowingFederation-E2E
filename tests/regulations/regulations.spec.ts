import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api } from "../../fixtures/lib/api.js";

/**
 * Institutional regulations by article — draft → publish cycle, insert-shift
 * renumbering, edit-and-republish supersede, reorder, derogate (hides
 * entirely, unlike an edit which still leaves a version visible), and the
 * role split (ADMIN/FEDERATION_ADMIN/DIRECTOR_ROLES/REGATTA_COMMISSION
 * manage; everyone else reads PUBLISHED only).
 */

interface RegulationDto {
  id: string;
}
interface SectionDto {
  id: string;
}
interface ArticleDto {
  id: string;
  slug: string;
  articleNumber: number;
  status: "DRAFT" | "PUBLISHED" | "DEROGADO";
  version: number;
  isLatestVersion: boolean;
  content: string;
}
interface RegulationWithContentDto {
  id: string;
  title: string;
  sections: Array<{ id: string; articles: ArticleDto[] }>;
}

async function createRegulationWithSection(adminToken: string, suffix: string) {
  const regulation = await api.post<{ data: RegulationDto }>(
    "/regulations",
    { title: `Reglamento E2E ${suffix}` },
    adminToken
  );
  const section = await api.post<{ data: SectionDto }>(
    `/regulations/${regulation.data.id}/sections`,
    { title: "Sección E2E" },
    adminToken
  );
  return { regulationId: regulation.data.id, sectionId: section.data.id };
}

test.describe("Regulations — draft/publish lifecycle", () => {
  test("a brand-new article starts as DRAFT, invisible on the public feed until published", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const draft = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>Contenido inicial</p>" },
      adminToken
    );
    expect(draft.data.status).toBe("DRAFT");
    expect(draft.data.version).toBe(1);

    const refereeToken = await apiLoginAs("REFEREE");
    const publicList = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations",
      refereeToken
    );
    const publicReg = publicList.data.find((r) => r.id === regulationId);
    expect(publicReg?.sections.flatMap((s) => s.articles)).toHaveLength(0);

    const published = await api.post<{ data: ArticleDto }>(
      `/regulations/articles/drafts/${draft.data.id}/publish`,
      {},
      adminToken
    );
    expect(published.data.status).toBe("PUBLISHED");

    const publicListAfter = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations",
      refereeToken
    );
    const publicRegAfter = publicListAfter.data.find((r) => r.id === regulationId);
    expect(publicRegAfter?.sections.flatMap((s) => s.articles).map((a) => a.id)).toContain(
      draft.data.id
    );
  });

  test("publishing a new article at an existing position shifts the sibling's number, without a version bump", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const first = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>Primero</p>" },
      adminToken
    );
    await api.post(`/regulations/articles/drafts/${first.data.id}/publish`, {}, adminToken);

    const inserted = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>Insertado en el medio</p>" },
      adminToken
    );
    const insertedPublished = await api.post<{ data: ArticleDto }>(
      `/regulations/articles/drafts/${inserted.data.id}/publish`,
      {},
      adminToken
    );
    expect(insertedPublished.data.articleNumber).toBe(1);

    const firstReloaded = await api.get<{ data: ArticleDto[] }>(
      `/regulations/articles/${first.data.slug}/versions`,
      adminToken
    );
    const firstLatest = firstReloaded.data[0]!;
    expect(firstLatest.articleNumber).toBe(2);
    expect(firstLatest.version).toBe(1); // shifted, not re-versioned
  });

  test("editing a published article creates a new version and supersedes the old one, keeping the same number", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const created = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>Original</p>" },
      adminToken
    );
    await api.post(`/regulations/articles/drafts/${created.data.id}/publish`, {}, adminToken);

    const draft2 = await api.post<{ data: ArticleDto }>(
      `/regulations/articles/${created.data.slug}/draft`,
      { content: "<p>Editado</p>" },
      adminToken
    );
    expect(draft2.data.version).toBe(2);
    expect(draft2.data.isLatestVersion).toBe(false);

    const republished = await api.post<{ data: ArticleDto }>(
      `/regulations/articles/drafts/${draft2.data.id}/publish`,
      {},
      adminToken
    );
    expect(republished.data.articleNumber).toBe(1);
    expect(republished.data.isLatestVersion).toBe(true);

    const versions = await api.get<{ data: ArticleDto[] }>(
      `/regulations/articles/${created.data.slug}/versions`,
      adminToken
    );
    expect(versions.data).toHaveLength(2);
    const v1 = versions.data.find((v) => v.version === 1);
    expect(v1?.isLatestVersion).toBe(false);
  });

  test("a second draft cannot be started while one is already in progress", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const created = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>Original</p>" },
      adminToken
    );
    await api.post(`/regulations/articles/drafts/${created.data.id}/publish`, {}, adminToken);
    await api.post(
      `/regulations/articles/${created.data.slug}/draft`,
      { content: "<p>Primer borrador</p>" },
      adminToken
    );

    await expect(
      api.post(
        `/regulations/articles/${created.data.slug}/draft`,
        { content: "<p>Segundo borrador</p>" },
        adminToken
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  test("derogating an article hides it entirely from the public feed", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const refereeToken = await apiLoginAs("REFEREE");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const created = await api.post<{ data: ArticleDto }>(
      `/regulations/${regulationId}/articles`,
      { sectionId, articleNumber: 1, content: "<p>A derogar</p>" },
      adminToken
    );
    await api.post(`/regulations/articles/drafts/${created.data.id}/publish`, {}, adminToken);

    const beforeList = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations",
      refereeToken
    );
    const beforeArticleIds = beforeList.data
      .find((r) => r.id === regulationId)
      ?.sections.flatMap((s) => s.articles.map((a) => a.id));
    expect(beforeArticleIds).toContain(created.data.id);

    const derogated = await api.post<{ data: ArticleDto }>(
      `/regulations/articles/${created.data.slug}/derogate`,
      {},
      adminToken
    );
    expect(derogated.data.status).toBe("DEROGADO");

    const afterList = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations",
      refereeToken
    );
    const afterArticleIds = afterList.data
      .find((r) => r.id === regulationId)
      ?.sections.flatMap((s) => s.articles.map((a) => a.id)) ?? [];
    expect(afterArticleIds).not.toContain(created.data.id);

    // Editors still see it (marked DEROGADO), for internal audit.
    const editorList = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations/editor",
      adminToken
    );
    const editorArticles = editorList.data
      .find((r) => r.id === regulationId)
      ?.sections.flatMap((s) => s.articles) ?? [];
    expect(editorArticles.find((a) => a.id === created.data.id)?.status).toBe("DEROGADO");
  });

  test("reordering shifts every article in between, atomically", async () => {
    const adminToken = await apiLoginAs("ADMIN");
    const suffix = randomUUID().slice(0, 8);
    const { regulationId, sectionId } = await createRegulationWithSection(adminToken, suffix);

    const articles: ArticleDto[] = [];
    for (let i = 1; i <= 3; i++) {
      const created = await api.post<{ data: ArticleDto }>(
        `/regulations/${regulationId}/articles`,
        { sectionId, articleNumber: i, content: `<p>Articulo ${i}</p>` },
        adminToken
      );
      const published = await api.post<{ data: ArticleDto }>(
        `/regulations/articles/drafts/${created.data.id}/publish`,
        {},
        adminToken
      );
      articles.push(published.data);
    }
    // Numbers 1, 2, 3 in creation order.
    const [first, second, third] = articles;

    // Move the first article to position 3 — second and third should shift down by one.
    await api.post(`/regulations/articles/${first!.slug}/reorder`, { newArticleNumber: 3 }, adminToken);

    const editorList = await api.get<{ data: RegulationWithContentDto[] }>(
      "/regulations/editor",
      adminToken
    );
    const finalArticles = editorList.data
      .find((r) => r.id === regulationId)
      ?.sections.flatMap((s) => s.articles) ?? [];

    expect(finalArticles.find((a) => a.id === first!.id)?.articleNumber).toBe(3);
    expect(finalArticles.find((a) => a.id === second!.id)?.articleNumber).toBe(1);
    expect(finalArticles.find((a) => a.id === third!.id)?.articleNumber).toBe(2);
  });
});

test.describe("Regulations — role permissions", () => {
  for (const role of ["REFEREE", "CLUB_DELEGATE"] as const) {
    test(`${role} can read but cannot manage regulations`, async () => {
      const adminToken = await apiLoginAs("ADMIN");
      const roleToken = await apiLoginAs(role);
      const suffix = randomUUID().slice(0, 8);

      const readList = await api.get(`/regulations`, roleToken);
      expect(readList).toBeTruthy();

      await expect(
        api.post(`/regulations`, { title: `No autorizado ${suffix}` }, roleToken)
      ).rejects.toMatchObject({ status: 403 });

      await expect(api.get(`/regulations/editor`, roleToken)).rejects.toMatchObject({
        status: 403,
      });

      // Sanity: ADMIN can, confirming the 403 above is role-based and not a
      // route/config error.
      const regulation = await api.post<{ data: RegulationDto }>(
        `/regulations`,
        { title: `Autorizado ${suffix}` },
        adminToken
      );
      expect(regulation.data.id).toBeTruthy();
    });
  }

  test("REGATTA_COMMISSION and DIRECTOR_ROLES can manage regulations", async () => {
    for (const role of ["REGATTA_COMMISSION", "PRESIDENT"] as const) {
      const token = await apiLoginAs(role);
      const suffix = randomUUID().slice(0, 8);
      const regulation = await api.post<{ data: RegulationDto }>(
        `/regulations`,
        { title: `Creado por ${role} ${suffix}` },
        token
      );
      expect(regulation.data.id).toBeTruthy();
    }
  });
});
