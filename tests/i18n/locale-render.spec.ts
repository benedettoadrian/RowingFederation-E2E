import { test, expect } from "@playwright/test";
import { loginAs } from "../../fixtures/auth.js";

/**
 * Fase 6.4 — Layer 3: real browser smoke check across all 3 locales.
 * 6.2/6.3 already statically guarantee no key is missing/empty/leaked —
 * this layer instead catches what static analysis can't: a broken
 * [locale] route, a malformed messages/<locale>.json failing to import at
 * runtime, or a page that only renders correctly in the default locale.
 * Not re-checking for literal missing-key artifacts (already covered).
 */

const PUBLIC_PAGES = ["/", "/contacto", "/historia", "/directiva"];
const LOCALES = ["es", "en", "pt"] as const;

for (const locale of LOCALES) {
  for (const pagePath of PUBLIC_PAGES) {
    test(`public page ${pagePath} renders in ${locale} @tier0`, async ({ page }) => {
      const response = await page.goto(`/${locale}${pagePath}`);
      expect(response?.status()).toBeLessThan(400);
      await expect(page.locator("body")).not.toContainText("Application error");
    });
  }
}

for (const locale of LOCALES) {
  test(`dashboard renders in ${locale} after login @tier0`, async ({ page }) => {
    await loginAs(page, "ADMIN");
    const response = await page.goto(`/${locale}/dashboard`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("body")).not.toContainText("Application error");
  });
}
