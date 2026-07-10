import { test, expect } from "@playwright/test";
import { api, ApiError } from "../../fixtures/lib/api.js";

// Fase 7.1 — invalid login must not leak whether an email is registered.
// Verified against login.use-case.ts: both "email doesn't exist" and
// "email exists, wrong password" return the exact same
// Result.fail("Invalid email or password") -> 401. Two other branches
// (deactivated account, unverified email) DO return distinguishable
// messages and would leak account-existence if reachable pre-password-check
// — not covered here (out of the original ask), noted for later.

test("nonexistent email returns the generic invalid-credentials error @tier0", async () => {
  await expect(
    api.post("/auth/login", { email: "does-not-exist@e2e.test", password: "WrongPass123" })
  ).rejects.toMatchObject({
    status: 401,
    body: { error: { message: "Invalid email or password" } },
  } satisfies Partial<ApiError>);
});

test("existing email with wrong password returns the SAME generic error (no enumeration) @tier0", async () => {
  await expect(
    api.post("/auth/login", { email: "admin@e2e.test", password: "DefinitelyWrongPassword1" })
  ).rejects.toMatchObject({
    status: 401,
    body: { error: { message: "Invalid email or password" } },
  } satisfies Partial<ApiError>);
});
