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
