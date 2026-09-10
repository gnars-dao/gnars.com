import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPFS_GATEWAYS } from "@/lib/ipfs";
import { GET } from "./route";

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: { readContract } }));

const address = "0x1111111111111111111111111111111111111111";
const otherAddress = "0x2222222222222222222222222222222222222222";
const ipfsPath = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3ptu2jthyxyjlbhxhbaszi5qu/metadata.json";
const sdkCoin = {
  address,
  chainId: 8453,
  name: "Creator Coin",
  symbol: "CREATOR",
  marketCap: "1000",
  mediaContent: { originalUri: `ipfs://${ipfsPath}` },
};

function request(value = address) {
  return new NextRequest(`http://localhost/api/coins/meta?address=${encodeURIComponent(value)}`);
}

describe("GET /api/coins/meta", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue(Response.json({ zora20Token: null }));
    vi.stubGlobal("fetch", fetchMock);
    readContract.mockRejectedValue(new Error("contractURI unavailable"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects malformed addresses without upstream requests", async () => {
    const response = await GET(request("not-an-address"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it("labels only a matching Base Zora response as Zora and skips fallback RPC", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ zora20Token: sdkCoin }));
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      coin: { address, name: "Creator Coin" },
      source: "zora",
    });
    expect(response.headers.get("cache-control")).toContain("s-maxage=600");
    expect(readContract).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    { address: otherAddress },
    { chainId: 1 },
    { chainId: undefined },
    { chainId: "8453" },
    { address: undefined },
    { name: { invalid: true } },
    { mediaContent: { originalUri: { invalid: true } } },
  ])("does not attribute mismatched or malformed SDK data: %j", async (change) => {
    fetchMock.mockResolvedValueOnce(Response.json({ zora20Token: { ...sdkCoin, ...change } }));
    const response = await GET(request());
    expect(await response.json()).toEqual({ coin: null, source: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("matches the returned address without depending on its checksum casing", async () => {
    const mixedAddress = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
    fetchMock.mockResolvedValueOnce(
      Response.json({ zora20Token: { ...sdkCoin, address: mixedAddress.toLowerCase() } }),
    );
    expect((await (await GET(request(mixedAddress))).json()).source).toBe("zora");
  });

  it("preserves IPFS artwork fallback without claiming Zora provenance", async () => {
    readContract.mockResolvedValue(`ipfs://${ipfsPath}`);
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ name: "Generic Collection", image: "ipfs://art" }));
    const response = await GET(request());
    expect(await response.json()).toEqual({
      coin: {
        address,
        name: "Generic Collection",
        symbol: null,
        description: null,
        mediaContent: { mimeType: null, originalUri: "ipfs://art", previewImage: null },
      },
      source: "onchain",
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      `${IPFS_GATEWAYS[0]}${ipfsPath}`,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    ]);
  });

  it("normalizes an existing IPFS gateway URL to the fixed primary gateway", async () => {
    readContract.mockResolvedValue(`https://arbitrary-gateway.example/ipfs/${ipfsPath}`);
    fetchMock
      .mockResolvedValueOnce(Response.json({ zora20Token: null }))
      .mockResolvedValueOnce(Response.json({ name: "Coin", image: "ipfs://art" }));
    expect((await (await GET(request())).json()).source).toBe("onchain");
    expect(fetchMock.mock.calls[1][0]).toBe(`${IPFS_GATEWAYS[0]}${ipfsPath}`);
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "https://metadata.coinbase.com/equity.json",
    "https://magic.decentralized-content.com.attacker.example/metadata.json",
    "file:///etc/passwd",
    "data:application/json,{}",
    "ipfs://../private",
    "ipfs://%2e%2e/private",
    `ipfs://${ipfsPath}?redirect=http://127.0.0.1`,
    `ipfs://${ipfsPath}#fragment`,
  ])("never server-fetches an untrusted contractURI: %s", async (uri) => {
    readContract.mockResolvedValue(uri);
    const response = await GET(request());
    expect(await response.json()).toEqual({ coin: null, source: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the gateway redirects instead of following it", async () => {
    readContract.mockResolvedValue(`ipfs://${ipfsPath}`);
    fetchMock
      .mockResolvedValueOnce(Response.json({ zora20Token: null }))
      .mockRejectedValueOnce(new TypeError("redirect disallowed"));
    expect(await (await GET(request())).json()).toEqual({ coin: null, source: null });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: "error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds streamed SDK responses and does not expose provider secrets", async () => {
    vi.stubEnv("ZORA_API_KEY", "private-api-secret");
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(65537)));
    const response = await GET(request());
    expect(await response.text()).toBe('{"coin":null,"source":null}');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([false, true])("bounds gateway responses (declared length: %s)", async (declared) => {
    readContract.mockResolvedValue(`ipfs://${ipfsPath}`);
    fetchMock.mockResolvedValueOnce(Response.json({ zora20Token: null })).mockResolvedValueOnce(
      new Response(declared ? "{}" : "x".repeat(65537), {
        headers: declared ? { "content-length": "65537" } : {},
      }),
    );
    expect(await (await GET(request())).json()).toEqual({ coin: null, source: null });
  });

  it("rejects malformed fallback media instead of sending invalid values to the card", async () => {
    readContract.mockResolvedValue(`ipfs://${ipfsPath}`);
    fetchMock
      .mockResolvedValueOnce(Response.json({ zora20Token: null }))
      .mockResolvedValueOnce(Response.json({ name: "Coin", content: { uri: { not: "a URL" } } }));
    expect(await (await GET(request())).json()).toEqual({ coin: null, source: null });
  });

  it("strips unrecognized upstream fields from public metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ zora20Token: { ...sdkCoin, privateDebug: "secret-value" } }),
    );
    const body = await (await GET(request())).json();
    expect(body.source).toBe("zora");
    expect(body.coin.privateDebug).toBeUndefined();
  });
});
