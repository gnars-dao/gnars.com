import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { corsPreflight, withCors } from "@/lib/server/cors";
import { RequestSecurityError } from "@/lib/server/request-security";
import { marketplaceErrorResponse } from "@/services/marketplace-common";

const ALLOWED = "https://ps1.r4to.com";
const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "vary",
];

function headerNames(response: Response) {
  return [...response.headers.keys()].sort();
}
function corsHeadersOn(response: Response) {
  return headerNames(response).filter((name) => CORS_HEADERS.includes(name));
}

const ok = withCors(async () =>
  Response.json({ listing: 1 }, { headers: { "Cache-Control": "no-store" } }),
);
const boom = withCors(async () => {
  try {
    throw new RequestSecurityError(429, "Too many requests. Try again later.", 25);
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
});

function req(origin?: string) {
  return new Request("https://gnars.com/api/marketplace/orders/0xabc", {
    headers: origin ? { origin } : {},
  });
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  delete process.env.MARKETPLACE_CORS_ORIGINS;
  vi.restoreAllMocks();
});

describe("1. env unset => CORS fully disabled", () => {
  it("returns the untouched response for success and error, with or without Origin", async () => {
    for (const origin of [undefined, ALLOWED, "https://evil.example"]) {
      const success = await ok(req(origin));
      expect(corsHeadersOn(success)).toEqual([]);
      expect(headerNames(success)).toEqual(["cache-control", "content-type"]);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ listing: 1 });

      const error = await boom(req(origin));
      expect(corsHeadersOn(error)).toEqual([]);
      expect(error.status).toBe(429);
      expect(error.headers.get("retry-after")).toBe("25");
    }
  });
  it("treats an empty/whitespace value as unset", async () => {
    for (const raw of ["", "   ", ",", " , "]) {
      process.env.MARKETPLACE_CORS_ORIGINS = raw;
      expect(corsHeadersOn(await ok(req(ALLOWED)))).toEqual([]);
      expect(corsPreflight(req(ALLOWED)).status).toBe(204);
      expect(corsHeadersOn(corsPreflight(req(ALLOWED)))).toEqual([]);
    }
  });
});

describe("2. env set + allowlisted Origin", () => {
  beforeEach(() => {
    process.env.MARKETPLACE_CORS_ORIGINS = ` https://other.example , ${ALLOWED}/ `;
  });
  it("echoes the exact origin and varies on Origin for a success response", async () => {
    const response = await ok(req(ALLOWED));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ listing: 1 });
  });
  it("echoes the exact origin on an error response and exposes Retry-After", async () => {
    const response = await boom(req(ALLOWED));
    expect(response.status).toBe(429);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("retry-after")).toBe("25");
    expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After, X-Request-Id");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST", retryable: true });
  });
  it("matches host case-insensitively but never with a wildcard or suffix", async () => {
    expect((await ok(req("https://PS1.R4TO.com"))).headers.get("access-control-allow-origin")).toBe(
      "https://PS1.R4TO.com",
    );
    for (const bad of [
      "http://ps1.r4to.com",
      "https://ps1.r4to.com:8443",
      "https://evil-ps1.r4to.com",
      "https://ps1.r4to.com.evil.test",
      "null",
      "*",
    ]) {
      expect(corsHeadersOn(await ok(req(bad)))).toEqual([]);
    }
  });
  it("appends to an existing Vary instead of clobbering it", async () => {
    const handler = withCors(async () => new Response("x", { headers: { Vary: "Accept-Encoding" } }));
    expect((await handler(req(ALLOWED))).headers.get("vary")).toBe("Accept-Encoding, Origin");
    const already = withCors(async () => new Response("x", { headers: { Vary: "origin" } }));
    expect((await already(req(ALLOWED))).headers.get("vary")).toBe("origin");
  });
});

describe("3. env set + non-allowlisted Origin", () => {
  beforeEach(() => {
    process.env.MARKETPLACE_CORS_ORIGINS = ALLOWED;
  });
  it("is byte-identical to the CORS-disabled response", async () => {
    for (const origin of [undefined, "https://evil.example"]) {
      const success = await ok(req(origin));
      expect(headerNames(success)).toEqual(["cache-control", "content-type"]);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ listing: 1 });

      const error = await boom(req(origin));
      expect(corsHeadersOn(error)).toEqual([]);
      expect(error.status).toBe(429);
      expect(error.headers.get("retry-after")).toBe("25");
    }
  });
});

describe("4. OPTIONS preflight", () => {
  beforeEach(() => {
    process.env.MARKETPLACE_CORS_ORIGINS = ALLOWED;
  });
  it("approves an allowlisted origin with 204 and the route's methods", async () => {
    const response = corsPreflight(req(ALLOWED), ["POST", "OPTIONS"]);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("gives a bare 204 with no CORS headers to a foreign origin", () => {
    const response = corsPreflight(req("https://evil.example"), ["GET", "OPTIONS"]);
    expect(response.status).toBe(204);
    expect(corsHeadersOn(response)).toEqual([]);
  });
});
