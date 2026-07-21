import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "./lib/api.js";

export type RoleKey =
  | "ADMIN"
  | "FEDERATION_ADMIN"
  | "PRESIDENT"
  | "VICE_PRESIDENT"
  | "GENERAL_SECRETARY"
  | "TREASURER"
  | "MINUTES_SECRETARY"
  | "REGATTA_COMMISSION"
  | "REFEREE"
  | "CLUB_DELEGATE"
  | "CLUB_DELEGATE_2"
  | "DELEGATE"
  | "COMMUNICATIONS";

interface Credentials {
  credentials: Record<RoleKey, { email: string; password: string; userId?: string }>;
  clubs: { club1: string; club2: string };
  athletes: { club1: string; club2: string };
}

const credentialsPath = fileURLToPath(new URL("./credentials.json", import.meta.url));

let cached: Credentials | undefined;

/** Loads fixtures/credentials.json, written by `npm run seed`. */
export function loadFixtures(): Credentials {
  if (!cached) {
    cached = JSON.parse(readFileSync(credentialsPath, "utf-8")) as Credentials;
  }
  return cached;
}

/**
 * Logs in through the real UI (not an API shortcut) — this is the one thing
 * every E2E test needs, so it's worth going through the actual form once
 * per test rather than injecting a token, to keep the auth flow itself
 * under continuous test coverage.
 */
export async function loginAs(page: Page, role: RoleKey): Promise<void> {
  const { credentials } = loadFixtures();
  const { email, password } = credentials[role];

  await page.goto("/es/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/(es|en|pt)\/dashboard/, { timeout: 10_000 });
}

/**
 * Logs in via the real API (no browser) and returns the access token. For
 * tests asserting a backend authorization boundary directly rather than a
 * UI flow — login itself is already covered continuously by loginAs()
 * above, so re-driving the login form here would just be redundant.
 */
export async function apiLoginAs(role: RoleKey): Promise<string> {
  const { credentials } = loadFixtures();
  const { email, password } = credentials[role];
  const login = await api.post<{ data: { accessToken: string } }>("/auth/login", {
    email,
    password,
  });
  return login.data.accessToken;
}
