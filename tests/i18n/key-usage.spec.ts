import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Fase 6.3 — Layer 2: every translation key actually referenced in Frontend
 * source (`useTranslations()` + `t("key")`) must exist in messages/es.json.
 * Regex-based, not a real AST parse (same ad-hoc approach used in the
 * Agazzi remediation's i18n audit, per fur-agazzi-remediation-plan Fase 8 —
 * that script wasn't persisted, this reimplements the same idea). Handles
 * the common `const t = useTranslations("namespace")` pattern, including
 * multiple differently-named translation vars per file (e.g. `tCommon`).
 * Does NOT handle dynamically-computed keys (`t(someVariable)`) — those are
 * silently skipped, a known limitation of static regex extraction.
 */

const FRONTEND_SRC = fileURLToPath(
  new URL("../../../RowingFederation-Frontend/src", import.meta.url)
);

function flatten(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const k of flatten(value as Record<string, unknown>, fullKey)) out.add(k);
    } else {
      out.add(fullKey);
    }
  }
  return out;
}

function loadDefinedKeys(): Set<string> {
  const messagesPath = fileURLToPath(
    new URL("../../../RowingFederation-Frontend/messages/es.json", import.meta.url)
  );
  return flatten(JSON.parse(readFileSync(messagesPath, "utf-8")));
}

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      files.push(...walkSourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith(".spec.ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

interface UsedKey {
  key: string;
  file: string;
}

function extractUsedKeys(files: string[]): UsedKey[] {
  const used: UsedKey[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const relFile = path.relative(FRONTEND_SRC, file);

    // Declarations WITH their character offset, not just a name->namespace
    // map — a file can have two components each declaring `const t =
    // useTranslations(...)` with a DIFFERENT namespace (e.g. one scoped
    // component + one default-export using the bare hook). A plain map
    // keyed by variable name only keeps the last declaration seen and
    // wrongly applies it to every usage in the file, including ones that
    // belong to an earlier component. Instead, each usage is matched to
    // its NEAREST PRECEDING declaration of the same variable name.
    const declarations: Array<{ varName: string; namespace: string; offset: number }> = [];
    for (const m of content.matchAll(
      /const\s+(\w+)\s*=\s*useTranslations\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g
    )) {
      const [, varName, namespace] = m;
      declarations.push({ varName, namespace: namespace ?? "", offset: m.index ?? 0 });
    }
    if (declarations.length === 0) continue;

    const varNames = new Set(declarations.map((d) => d.varName));
    for (const varName of varNames) {
      const callRegex = new RegExp(
        `\\b${varName}(?:\\.rich|\\.markup|\\.raw)?\\(\\s*["'\`]([^"'\`]+)["'\`]`,
        "g"
      );
      const candidateDecls = declarations
        .filter((d) => d.varName === varName)
        .sort((a, b) => a.offset - b.offset);

      for (const m of content.matchAll(callRegex)) {
        const callOffset = m.index ?? 0;
        const decl =
          [...candidateDecls].reverse().find((d) => d.offset <= callOffset) ?? candidateDecls[0];
        const namespace = decl.namespace;
        const key = namespace ? `${namespace}.${m[1]}` : m[1];
        used.push({ key, file: relFile });
      }
    }
  }

  return used;
}

test("every t()-referenced translation key exists in messages/es.json @tier0", async () => {
  const definedKeys = loadDefinedKeys();
  const files = walkSourceFiles(FRONTEND_SRC);
  const usedKeys = extractUsedKeys(files);

  // Template-literal interpolated keys (e.g. `athletes.cardVerify.${status}.title`)
  // can't be resolved statically — a real AST-based check would need to
  // enumerate the possible values of `status` from its type, which is out
  // of scope for a regex-based extractor. Skipped here rather than reported
  // as false-positive missing keys; each one was manually verified against
  // the interpolated variable's possible values at least once (2026-07-10)
  // and the corresponding concrete keys DO exist in es.json.
  const missing = usedKeys.filter((u) => !u.key.includes("${") && !definedKeys.has(u.key));

  expect(
    missing.map((m) => `${m.key} (${m.file})`),
    `Keys referenced in code but missing from es.json:\n${missing
      .map((m) => `  ${m.key} — ${m.file}`)
      .join("\n")}`
  ).toEqual([]);
});
