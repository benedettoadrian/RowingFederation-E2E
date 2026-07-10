import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Fase 6.2 — Layer 1: static JSON key parity across es/en/pt. Pure
 * filesystem check, no browser/backend needed. Reads the Frontend repo's
 * messages/*.json directly as a sibling directory (same convention
 * docker-compose.e2e.yml already uses for the app repos).
 */

function flatten(obj: Record<string, unknown>, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Record<string, unknown>, fullKey)) {
        out.set(k, v);
      }
    } else {
      out.set(fullKey, value);
    }
  }
  return out;
}

function loadMessages(locale: string): Map<string, unknown> {
  const path = fileURLToPath(
    new URL(`../../../RowingFederation-Frontend/messages/${locale}.json`, import.meta.url)
  );
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return flatten(raw);
}

test("es/en/pt have exactly the same set of translation keys @tier0", async () => {
  const es = loadMessages("es");
  const en = loadMessages("en");
  const pt = loadMessages("pt");

  const esKeys = new Set(es.keys());
  const enKeys = new Set(en.keys());
  const ptKeys = new Set(pt.keys());

  const missingFromEn = [...esKeys].filter((k) => !enKeys.has(k));
  const missingFromPt = [...esKeys].filter((k) => !ptKeys.has(k));
  const extraInEn = [...enKeys].filter((k) => !esKeys.has(k));
  const extraInPt = [...ptKeys].filter((k) => !esKeys.has(k));

  expect(missingFromEn, `Keys in es.json missing from en.json: ${missingFromEn.join(", ")}`).toEqual([]);
  expect(missingFromPt, `Keys in es.json missing from pt.json: ${missingFromPt.join(", ")}`).toEqual([]);
  expect(extraInEn, `Keys in en.json not present in es.json: ${extraInEn.join(", ")}`).toEqual([]);
  expect(extraInPt, `Keys in pt.json not present in es.json: ${extraInPt.join(", ")}`).toEqual([]);
});

test("no translation value is an empty string in any locale @tier0", async () => {
  for (const locale of ["es", "en", "pt"]) {
    const messages = loadMessages(locale);
    const empty = [...messages.entries()].filter(([, v]) => v === "");
    expect(empty.map(([k]) => k), `Empty values in ${locale}.json: ${empty.map(([k]) => k).join(", ")}`).toEqual(
      []
    );
  }
});

test("no translation value is literally the key path itself (a common copy-paste leftover) @tier0", async () => {
  for (const locale of ["es", "en", "pt"]) {
    const messages = loadMessages(locale);
    const leaked = [...messages.entries()].filter(([k, v]) => v === k);
    expect(
      leaked.map(([k]) => k),
      `Values equal to their own key path in ${locale}.json: ${leaked.map(([k]) => k).join(", ")}`
    ).toEqual([]);
  }
});
