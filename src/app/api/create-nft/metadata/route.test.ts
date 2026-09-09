import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  signature: vi.fn(),
  eligibility: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("viem/actions", () => ({ verifyMessage: mocks.signature }));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: {} }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
vi.mock("@/services/marketplace-community", () => ({ getCommunityEligibility: mocks.eligibility }));
const wallet = "0x1111111111111111111111111111111111111111";
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udglxzxl4ehxd5vcsgyo5jui";
const metadata = { name: "My NFT", description: "Original artwork", image: `ipfs://${cid}` };
function authorization(overrides = {}) {
  return {
    walletAddress: wallet,
    issuedAt: Date.now(),
    nonce: "97a9a940-eb45-4482-8da0-aa1423b712e1",
    signature: "0xabcd",
    ...overrides,
  };
}
function request(body: unknown = { metadata, authorization: authorization() }) {
  return new Request("https://www.gnars.com/api/create-nft/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PINATA_JWT", "private-pinata-token");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.signature.mockResolvedValue(true);
  mocks.eligibility.mockResolvedValue({ eligible: true, balance: "6" });
  mocks.fetch.mockResolvedValue(Response.json({ IpfsHash: cid }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("NFT metadata upload authorization", () => {
  it("pins only validated metadata and verified creator attribution", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ uri: `ipfs://${cid}` });
    expect(mocks.eligibility).toHaveBeenCalledExactlyOnceWith(wallet);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    expect(options.headers.Authorization).toBe("Bearer private-pinata-token");
    expect(options.cache).toBe("no-store");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({
      pinataContent: {
        ...metadata,
        external_url: "https://www.gnars.com/marketplace",
        attributes: [{ trait_type: "Creator", value: wallet }],
      },
      pinataMetadata: { name: metadata.name },
    });
    expect(mocks.signature.mock.calls[0][1].message).toContain("/api/create-nft/metadata");
    expect(mocks.rate).toHaveBeenLastCalledWith(expect.any(Request), {
      scope: "nft-metadata-wallet",
      subject: wallet,
      limit: 10,
      windowSeconds: 3600,
    });
  });
  it.each([undefined, {}, { walletAddress: wallet }])(
    "rejects missing or malformed authorization %j",
    async (auth) => {
      const response = await POST(request({ metadata, authorization: auth }));
      expect(response.status).toBe(401);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.eligibility).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid signatures without checking membership or uploading", async () => {
    mocks.signature.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.eligibility).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([-3_600_000, 120_000])(
    "rejects expired or future authorization (%i ms)",
    async (offset) => {
      const response = await POST(
        request({ metadata, authorization: authorization({ issuedAt: Date.now() + offset }) }),
      );
      expect(response.status).toBe(401);
      expect(mocks.signature).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("fails closed when signature verification RPC is unavailable", async () => {
    mocks.signature.mockRejectedValue(new Error("RPC private-pinata-token"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-pinata-token");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("requires six Gnars before any paid provider operation", async () => {
    mocks.eligibility.mockResolvedValue({ eligible: false, balance: "5" });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("fails closed when membership verification fails", async () => {
    mocks.eligibility.mockRejectedValue(new Error("database private-pinata-token"));
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("private-pinata-token");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { metadata: {} },
    { metadata: { ...metadata, image: "https://evil.example/image" } },
    { metadata: { ...metadata, name: " " } },
    { metadata: { ...metadata, attributes: [] } },
  ])("rejects malformed metadata or envelope %j", async (payload) => {
    const response = await POST(request(payload));
    expect(response.status).toBe(400);
    expect(mocks.signature).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("bounds and validates the JSON request body", async () => {
    for (const [body, status] of [
      ["{", 400],
      ["x".repeat(24001), 413],
    ] as const) {
      const response = await POST(
        new Request("https://www.gnars.com/api/create-nft/metadata", { method: "POST", body }),
      );
      expect(response.status).toBe(status);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("enforces IP and wallet rate limits before upload", async () => {
    mocks.rate.mockRejectedValueOnce(new RequestSecurityError(429, "Rate limit", 60));
    const first = await POST(request());
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("60");
    expect(mocks.signature).not.toHaveBeenCalled();
    mocks.rate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RequestSecurityError(429, "Rate limit", 60));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not upload without a configured server credential", async () => {
    vi.stubEnv("PINATA_JWT", "");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])("sanitizes provider HTTP %i errors", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("private-pinata-token", { status }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-pinata-token");
  });
  it.each([{}, { IpfsHash: 42 }, { IpfsHash: "../secret" }])(
    "rejects malformed provider metadata %j",
    async (payload) => {
      mocks.fetch.mockResolvedValue(Response.json(payload));
      expect((await POST(request())).status).toBe(502);
    },
  );
  it("sanitizes network failures", async () => {
    mocks.fetch.mockRejectedValue(new Error("private-pinata-token"));
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("private-pinata-token");
  });
});
