/** Resolve API base URL into an absolute base ending with `/api/v1`.
 *
 * Strategy:
 * - `NEXT_PUBLIC_API_BASE_URL` may be either:
 *   1) backend origin only: `https://example.com`
 *   2) already including `/api/v1`: `https://example.com/api/v1`
 *   3) a relative dev proxy path: `/api/v1`
 *
 * This function normalizes all cases into exactly `${origin}/api/v1` (or `/api/v1` in-browser).
 */
export function getApiBaseUrl(): string {
  const API_V1_PATH = "/api/v1";
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  const proxyOrigin = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const debug = process.env.NEXT_PUBLIC_API_DEBUG === "true";

  if (configured) {
    // Relative proxy path: `/api/v1` for dev.
    if (configured.startsWith("/")) {
      if (typeof window !== "undefined") return configured;
      return `${proxyOrigin}${configured}`;
    }

    // Absolute origin or origin+`/api/v1`.
    const origin = configured.replace(new RegExp(`${API_V1_PATH}/?$`), "");
    return `${origin}${API_V1_PATH}`;
  }

  // No explicit config: use Next.js dev proxy path in browser.
  if (typeof window !== "undefined") return API_V1_PATH;
  return `${proxyOrigin}${API_V1_PATH}`;
}

export const API_BASE_URL = getApiBaseUrl();
/** WebSocket API base (direct to backend when REST uses `/api/v1` proxy). */
export function getWsApiBase(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_API_BASE_URL?.replace(/\/$/, "");
  if (explicit) {
    return explicit.replace(/^http/i, "ws");
  }
  const base = getApiBaseUrl();
  if (/^https?:\/\//i.test(base)) {
    return base.replace(/^http/i, "ws");
  }
  // Fallback for browser when API_BASE_URL is relative (e.g., '/api/v1')
  return "ws://127.0.0.1:8000/api/v1";
}
// ---------------------------------------------------------------------------
// Lightweight GET-request cache (prevents duplicate in-flight + re-render fetches)
// ---------------------------------------------------------------------------
type CacheEntry = { data: unknown; expiresAt: number; inflight?: Promise<unknown> };
const _getCache = new Map<string, CacheEntry>();
const _GET_CACHE_TTL_MS = 30_000; // 30 s — safe for list endpoints that poll anyway

/** Expose for manual invalidation (e.g. after mutations). */
export function invalidateApiCache(pathPrefix?: string) {
  if (!pathPrefix) {
    _getCache.clear();
    return;
  }
  for (const key of _getCache.keys()) {
    if (key.startsWith(pathPrefix)) _getCache.delete(key);
  }
}

export class ApiError extends Error {
  status: number;
  detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function toErrorMessage(detail: unknown, status: number): string {
  if (!detail) {
    return `Request failed with status ${status}`;
  }
  if (typeof detail === "string") {
    return detail;
  }
  if (typeof detail === "object") {
    const record = detail as { detail?: unknown; error?: unknown; message?: unknown };
    const serverError =
      typeof record.error === "string" && record.error.trim() ? record.error.trim() : null;
    if (typeof record.detail === "string") {
      const detailText = record.detail;
      if (
        serverError &&
        detailText.toLowerCase() === "internal server error" &&
        serverError.toLowerCase() !== detailText.toLowerCase()
      ) {
        return serverError;
      }
      return detailText;
    }
    if (serverError) {
      return serverError;
    }
    if (Array.isArray(record.detail) && record.detail.length > 0) {
      const first = record.detail[0] as { msg?: unknown };
      if (typeof first?.msg === "string") {
        return first.msg;
      }
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return `Request failed with status ${status}`;
}

/** Maps HTTP status to short, user-facing copy (403/401-aware). */
export function formatApiErrorForUser(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return "You don't have permission to perform this action.";
    }
    if (err.status === 401) {
      return "Your session expired. Please sign in again.";
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

type RequestOptions = RequestInit & {
  auth?: boolean;
  /** Abort the request after this many milliseconds (non-blocking server work should not require long waits). */
  timeoutMs?: number;
  /** When true, failed responses log as warn (avoids Next.js dev error overlay for optional fetches). */
  silentErrors?: boolean;
};

function getAuthToken() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem("airis_access_token");
}

function shouldSuppressApiErrorLog(path: string, status: number): boolean {
  // Legacy candidates can exist without candidate-management timeline rows.
  if (
    status === 404 &&
    /^\/candidate-management\/candidates\/[^/]+\/interactions(?:\?|$)/.test(path)
  ) {
    return true;
  }
  // Mixed candidate stores: ATS route may 404 for candidate-management-only IDs.
  if (status === 404 && /^\/candidates\/[^/]+\/matches(?:\?|$)/.test(path)) {
    return true;
  }
  // Placement history uses legacy /candidates/{id}/placements — 404 degrades to empty in UI.
  if (status === 404 && /^\/candidates\/[^/]+\/placements(?:\?|$)/.test(path)) {
    return true;
  }
  // Job removed, wrong org, or no access — detail page degrades without console spam.
  if (status === 404 && /^\/jobs\/[^/]+\/matches(?:\?|$)/.test(path)) {
    return true;
  }
  // GET single job by id (UUID) — not list (`/jobs?`) or static routes like `/jobs/search`.
  if (
    status === 404 &&
    /^\/jobs\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\?.*)?$/i.test(path)
  ) {
    return true;
  }
  // Older backends without POST /jobs/{id}/submit, or rollout mismatch — candidates page PATCH-fallback.
  if (status === 404 && /^\/jobs\/[^/]+\/submit(?:\?|$)/.test(path)) {
    return true;
  }
  // Rescore 404 is expected when the candidate has no job submissions / ATS rows yet.
  if (status === 404 && /^\/candidates\/[^/]+\/rescore(?:\?|$)/.test(path)) {
    return true;
  }
  // Candidate is already submitted to this job (idempotent UX flow).
  if (status === 409 && /^\/jobs\/[^/]+\/submit(?:\?|$)/.test(path)) {
    return true;
  }
  // Duplicate feedback or claim submission — expected domain conflict, not a bug.
  if (status === 409 && /^\/interviews\/[^/]+\/(feedback|claim)(?:\?|$)/.test(path)) {
    return true;
  }
  // Some pages optionally fetch org users for dropdowns; 403/500 are non-blocking there.
  if ((status === 403 || status === 500) && /^\/users(?:\?|$|\/)/.test(path)) {
    return true;
  }
  // Interviews feature may not be set up for all candidates/orgs.
  if (status === 500 && /^\/candidate-management\/candidates\/[^/]+\/interviews(?:\?|$)/.test(path)) {
    return true;
  }
  // LiveKit 503 means the feature isn't configured on this backend instance —
  // this is an expected operational state, not a bug.  LiveKitRoom handles it
  // gracefully by falling back to the companion panel.
  if (status === 503 && /^\/interviews\/[^/]+\/livekit\/token(?:\?|$)/.test(path)) {
    return true;
  }
  return false;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  /** Override the default 30 s GET-cache TTL. Pass 0 to skip caching entirely. */
  cacheTtlMs: number = _GET_CACHE_TTL_MS,
): Promise<T> {
  const { auth = true, timeoutMs, headers, signal: userSignal, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();

  // Only cache GET requests executed in a browser context.
  if (method === "GET" && cacheTtlMs > 0 && typeof window !== "undefined") {
    const now = Date.now();
    const hit = _getCache.get(path);
    if (hit) {
      // Return live or in-flight data without an extra network round-trip.
      if (hit.expiresAt > now) {
        return hit.data as T;
      }
      if (hit.inflight) return hit.inflight as Promise<T>;
    }
    // Prime the inflight dedup slot before the fetch starts.
    const entry: CacheEntry = { data: undefined, expiresAt: 0 };
    _getCache.set(path, entry);
    entry.inflight = _fetchRaw<T>(path, options).then((result) => {
      entry.data = result;
      entry.expiresAt = Date.now() + cacheTtlMs;
      entry.inflight = undefined;
      return result;
    }).catch((err) => {
      _getCache.delete(path);
      throw err;
    });
    return entry.inflight as Promise<T>;
  }

  // Non-GET or cache disabled — go straight to the network.
  return _fetchRaw<T>(path, options);
}

async function _fetchRaw<T>(path: string, options: RequestOptions): Promise<T> {
  const { auth = true, timeoutMs, silentErrors, headers, signal: userSignal, ...rest } = options;
  const token = auth ? getAuthToken() : null;

  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => abortController.abort(), timeoutMs);
  }
  if (userSignal) {
    if (userSignal.aborted) {
      abortController.abort();
    } else {
      userSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }
  const signal = abortController.signal;

  let response: Response;
  try {
    const base = getApiBaseUrl();
    const url = `${base}${path}`;
    response = await fetch(url, {
      ...rest,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });

    if (process.env.NEXT_PUBLIC_API_DEBUG === "true") {
      const contentType = response.headers.get("content-type") ?? "";
      console.debug(`[API DEBUG] ${url} -> ${response.status} content-type=${contentType}`);
    }
  } catch (error: unknown) {
    const aborted =
      error instanceof Error && error.name === "AbortError";
    if (aborted) {
      const message =
        timeoutMs != null && timeoutMs > 0
          ? `Request timed out after ${timeoutMs / 1000}s. The server may still be processing — try refreshing.`
          : "Request was cancelled.";
      throw new ApiError(message, 0, error);
    }
    const base = getApiBaseUrl();
    const url = `${base}${path}`;
    const message =
      `Cannot reach the API at ${url}. ` +
      "Check that NEXT_PUBLIC_API_BASE_URL is set correctly and that the backend routes are exposed under `/api/v1`.";
    console.error(`[API Network Error] ${url}:`, error);
    throw new ApiError(message, 0, error);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem("airis_access_token");
      } catch {
        /* ignore */
      }
      window.location.replace("/login");
    }
    // Read the body exactly once (streams can only be consumed once).
    // Then try to parse as JSON; fall back to the raw string.
    let detail: unknown = null;
    try {
      const raw = await response.text();
      if (raw) {
        try {
          detail = JSON.parse(raw);
        } catch {
          detail = raw;
        }
      }
    } catch {
      /* body unreadable — leave detail as null */
    }
    const message = toErrorMessage(detail, response.status);
    const expectedCandidateConflict =
      response.status === 409 &&
      (path.includes("/candidate-management/candidates") || /^\/jobs\/[^/]+\/submit(?:\?|$)/.test(path));
    const suppressErrorLog = shouldSuppressApiErrorLog(path, response.status) || Boolean(silentErrors);

    if (expectedCandidateConflict) {
      // Expected domain conflict; avoid noisy dev overlay.
      console.warn(`[API Conflict] ${response.status} ${path}: candidate already exists or conflicting payload`);
    } else if (suppressErrorLog) {
      console.warn(`[API Expected] ${response.status} ${path}: suppressed noisy error log`);
    } else {
      console.error(`[API Error] ${response.status} ${path}:`, detail);
    }
    throw new ApiError(message, response.status, detail);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
