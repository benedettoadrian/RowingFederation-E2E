import { test, expect } from "@playwright/test";
import { apiLoginAs } from "../../fixtures/auth.js";
import { api, ApiError, TINY_PNG_BASE64 } from "../../fixtures/lib/api.js";
import { API_URL } from "../../fixtures/lib/config.js";

/**
 * POST /news/editor-images — inline image upload for RichTextEditor's
 * image button. Deliberately decoupled from any newsId/NewsPhoto entity:
 * must work while composing a brand-new, not-yet-saved article. Same
 * requiresNewsManage() role guard as the rest of the news admin endpoints.
 */

function appendTinyPng(form: FormData) {
  const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
  form.append("image", new Blob([bytes], { type: "image/png" }), "editor-image.png");
}

test("golden path: DELEGATE uploads an editor image and gets back a public URL @tier0", async () => {
  const token = await apiLoginAs("DELEGATE");
  const form = new FormData();
  appendTinyPng(form);

  const result = await api.postMultipart<{ data: { url: string } }>(
    "/news/editor-images",
    form,
    token
  );

  expect(result.data.url).toMatch(/^news\/editor-images\/.+\.png$/);

  // Storage path starts with "news/" — one of the PUBLIC_FILE_PREFIXES in
  // file.routes.ts, so the URL the editor embeds in <img src> must be
  // reachable without auth (unlike identity documents, which require it).
  // /files/* is mounted at the app root, NOT under /api/v1 (express.app.ts:103).
  const fileRes = await fetch(`${API_URL}/files/${result.data.url}`);
  expect(fileRes.status).toBe(200);
});

test("CLUB_DELEGATE cannot upload an editor image @tier0", async () => {
  const token = await apiLoginAs("CLUB_DELEGATE");
  const form = new FormData();
  appendTinyPng(form);

  await expect(api.postMultipart("/news/editor-images", form, token)).rejects.toMatchObject({
    status: 403,
  } satisfies Partial<ApiError>);
});

test("rejects when no file is attached @tier0", async () => {
  const token = await apiLoginAs("DELEGATE");
  const form = new FormData();

  await expect(api.postMultipart("/news/editor-images", form, token)).rejects.toMatchObject({
    status: 400,
  } satisfies Partial<ApiError>);
});
