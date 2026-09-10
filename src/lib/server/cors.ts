import "server-only";

/**
 * Opt-in, origin-allowlisted CORS for the two marketplace routes a third-party
 * browser must call directly (`POST /api/marketplace/fulfillment` and
 * `GET /api/marketplace/orders/[hash]`).
 *
 * Calling those routes from the user's own browser — instead of proxying them
 * through another server — is what keeps `enforceRateLimit` keyed on the real
 * client IP (`x-vercel-forwarded-for`) and keeps a single integrator from
 * draining the shared 40/min marketplace budget.
 *
 * Safety properties, in order of importance:
 * - Unset or empty `MARKETPLACE_CORS_ORIGINS` disables CORS entirely: responses
 *   are returned untouched, byte-identical to a build without this module.
 * - The allowed origin is echoed back verbatim. `*` is never emitted.
 * - `Access-Control-Allow-Credentials` is never emitted: these routes read no
 *   cookies, and credentials + an echoed origin is a well-known footgun.
 * - Matching is exact on scheme + host + port. No wildcards, suffixes or regex.
 */

/** Comma-separated exact origins, e.g. `https://ps1.r4to.com,https://staging.r4to.com`. */
const ORIGINS_ENV = "MARKETPLACE_CORS_ORIGINS";

/** Response headers a cross-origin caller must be able to read on error paths. */
const EXPOSED_HEADERS = "Retry-After, X-Request-Id";

const PREFLIGHT_MAX_AGE_SECONDS = 600;

let memoizedRaw: string | null = null;
let memoizedOrigins: readonly string[] = [];

/**
 * Parsed once and reused. The raw value is kept alongside the parsed list so a
 * test can swap `process.env` and still observe the new allowlist; in a
 * deployed process the env never changes, so this is a single string compare.
 */
function allowedOrigins(): readonly string[] {
  const raw = process.env[ORIGINS_ENV] ?? "";
  if (raw !== memoizedRaw) {
    memoizedRaw = raw;
    memoizedOrigins = raw
      .split(",")
      .map((entry) => entry.trim().replace(/\/+$/, "").toLowerCase())
      .filter((entry) => entry.length > 0);
  }
  return memoizedOrigins;
}

/**
 * The exact `Origin` header value to echo back, or `null` when the request must
 * be answered with no CORS headers at all (CORS disabled, same-origin request,
 * or an origin that is not on the allowlist).
 */
function resolveAllowedOrigin(request: Request): string | null {
  const allowlist = allowedOrigins();
  if (allowlist.length === 0) return null;
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return allowlist.includes(origin.toLowerCase()) ? origin : null;
}

/** Adds `Origin` to `Vary` without clobbering values another layer already set. */
function varyOnOrigin(headers: Headers): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Origin");
    return;
  }
  const tokens = existing.split(",").map((token) => token.trim().toLowerCase());
  if (tokens.includes("*") || tokens.includes("origin")) return;
  headers.append("Vary", "Origin");
}

/**
 * Rebuilds the response with CORS headers attached. A copy is used rather than
 * an in-place mutation so an immutable `Headers` guard (any response that ever
 * originates from `fetch`) cannot make this throw.
 */
function attachCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  varyOnOrigin(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type RouteHandler<TArgs extends unknown[]> = (
  request: Request,
  ...args: TArgs
) => Response | Promise<Response>;

/**
 * Wraps a route handler so every response it produces — including the 4xx/5xx
 * bodies built by `marketplaceErrorResponse` — carries the CORS headers. A
 * browser cannot read a 429 or its `Retry-After` unless the error response
 * itself is CORS-enabled, so this must wrap the handler rather than decorate
 * individual success returns.
 */
export function withCors<TArgs extends unknown[]>(
  handler: RouteHandler<TArgs>,
): RouteHandler<TArgs> {
  return async (request, ...args) => {
    const response = await handler(request, ...args);
    const origin = resolveAllowedOrigin(request);
    return origin ? attachCorsHeaders(response, origin) : response;
  };
}

/**
 * `OPTIONS` handler for a CORS-enabled route. An allowlisted origin gets a 204
 * preflight approval; anything else gets a bare 204 with no CORS headers, which
 * the browser correctly treats as a failed preflight.
 */
export function corsPreflight(
  request: Request,
  methods: readonly string[] = ["GET", "POST", "OPTIONS"],
): Response {
  const origin = resolveAllowedOrigin(request);
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods.join(", "),
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Expose-Headers": EXPOSED_HEADERS,
      "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
      Vary: "Origin",
    },
  });
}
