import { API_URL } from "./config.js";

export class ApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: unknown
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw new ApiError(method, path, res.status, json);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, token?: string) => request<T>("GET", path, { token }),
  post: <T>(path: string, body: unknown, token?: string) =>
    request<T>("POST", path, { body, token }),
  patch: <T>(path: string, body: unknown, token?: string) =>
    request<T>("PATCH", path, { body, token }),
  put: <T>(path: string, body: unknown, token?: string) =>
    request<T>("PUT", path, { body, token }),
  delete: <T>(path: string, token?: string, body?: unknown) => request<T>("DELETE", path, { token, body }),
  postMultipart: async <T>(path: string, form: FormData, token?: string): Promise<T> => {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new ApiError("POST", path, res.status, json);
    }
    return json as T;
  },
};

/** Some write paths (crew-entry results, master-handicap, race-execution
 * claims, etc.) deliberately use a Postgres Serializable transaction to
 * enforce a CAS-style invariant — see e.g.
 * assign-finish-mark.use-case.ts's doc comment. The loser of a genuine
 * concurrent collision surfaces as a 400 "CONFLICT: transaction conflict,
 * please retry" and is meant to be retried by the caller (by design, not a
 * bug) — under Playwright's real parallel load this becomes common enough
 * to need a shared retry helper rather than each spec file rolling its own.
 *
 * `crew_entry_results` is a small, insert-heavy table during a full test
 * run — Postgres SSI takes index-gap predicate locks on INSERT that can
 * conflict across logically-unrelated rows sharing a B-tree page under
 * heavy concurrent writes, so the contention window isn't a single instant,
 * it can be a sustained multi-second burst. A fixed attempt count with a
 * short backoff (previously 5 attempts/1.5s, then 8/9s, then a 20s
 * wall-clock budget) was empirically still not always enough under
 * full-suite peak load — the deterministic backoff (300ms * attempt, no
 * jitter) meant every caller stuck in a retry storm recalculated the exact
 * same delay and re-collided with each other in near lockstep instead of
 * spreading out. Retries on a wall-clock budget (adapts to however long the
 * burst actually lasts) plus randomized jitter (breaks that lockstep). */
export async function withConflictRetry<T>(fn: () => Promise<T>, maxWaitMs = 30_000): Promise<T> {
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const isConflict =
        error instanceof ApiError && error.status === 400 && /CONFLICT/.test(String(error.body));
      const elapsed = Date.now() - start;
      if (!isConflict || elapsed >= maxWaitMs) throw error;
      attempt += 1;
      // Small backoff so a still-in-flight contending transaction has time to
      // clear before the next attempt, instead of retrying back-to-back into
      // the same collision under sustained parallel load. Capped so it
      // doesn't blow past maxWaitMs in one jump on later attempts; jittered
      // so concurrent retriers don't all wake up and re-collide together.
      const backoff = Math.min(300 * attempt, 2000) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/** Smallest possible valid PNG (1x1, transparent) — neither the backend's
 * fileFilter nor the OCR stub inspect real image content, only
 * mimetype/extension, so this is sufficient for upload-flow tests. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function waitForHealth(maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Backend did not become healthy within ${maxWaitMs}ms at ${API_URL}/health`);
}
