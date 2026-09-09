import { getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { getMarketplaceWalletNfts } from "./marketplace-wallet-nfts";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const fetchMock = vi.fn();
const owner = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const smartWallet = "0x2222222222222222222222222222222222222222";
const collection = "0x3333333333333333333333333333333333333333";
function nft(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: "7",
    tokenType: "ERC721",
    name: " Art ",
    contract: { address: collection, tokenType: "ERC721", name: " Community " },
    image: { cachedUrl: "https://example.com/art.png" },
    ...overrides,
  };
}
function respond(ownedNfts: unknown[] = [nft()], pageKey: string | null = null) {
  return Response.json({ ownedNfts, pageKey });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ALCHEMY_API_KEY", "server-secret");
  fetchMock.mockResolvedValue(respond());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("community wallet NFT discovery", () => {
  it.each([owner, smartWallet])(
    "queries the exact owner %s on Base without admin inference",
    async (address) => {
      const result = await getMarketplaceWalletNfts(address);
      const [url, options] = fetchMock.mock.calls[0];
      const requestUrl = new URL(url);
      expect(requestUrl.origin).toBe("https://base-mainnet.g.alchemy.com");
      expect(requestUrl.pathname).toBe("/nft/v3/server-secret/getNFTsForOwner");
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        owner: getAddress(address),
        pageSize: "24",
        withMetadata: "true",
        tokenUriTimeoutInMs: "0",
      });
      expect(options).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
      expect(result).toEqual({
        items: [
          {
            collectionAddress: collection,
            tokenId: "7",
            name: "Art",
            collectionName: "Community",
            image: "https://example.com/art.png",
            owner: getAddress(address),
            offers: [],
          },
        ],
        nextCursor: null,
      });
      expect(result).not.toHaveProperty("ownershipVerified");
      expect(JSON.stringify(result)).not.toContain("server-secret");
    },
  );

  it("preserves opaque page keys and makes one request per page", async () => {
    const cursor = "opaque+/key==&value";
    fetchMock.mockResolvedValueOnce(respond([], cursor));
    expect(await getMarketplaceWalletNfts(owner)).toEqual({ items: [], nextCursor: cursor });
    fetchMock.mockResolvedValueOnce(respond());
    expect((await getMarketplaceWalletNfts(owner, cursor)).nextCursor).toBeNull();
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("pageKey")).toBe(cursor);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent requests across address case variations", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const first = getMarketplaceWalletNfts(owner);
    const second = getMarketplaceWalletNfts(getAddress(owner));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(respond());
    expect(await first).toEqual(await second);
  });

  it("excludes Gnars, ERC1155, unknown types, and provider-classified spam", async () => {
    fetchMock.mockResolvedValueOnce(
      respond([
        nft({ contract: { address: DAO_ADDRESSES.token.toUpperCase().replace("0X", "0x") } }),
        nft({ tokenType: "ERC1155" }),
        nft({ tokenType: "UNKNOWN" }),
        nft({ tokenType: null, contract: { address: collection } }),
        nft({ contract: { address: collection, isSpam: true } }),
        nft({ contract: { address: collection, spamClassifications: ["Airdrop"] } }),
        nft({ tokenId: "0x08", tokenType: null }),
      ]),
    );
    expect((await getMarketplaceWalletNfts(owner)).items.map((item) => item.tokenId)).toEqual([
      "8",
    ]);
  });

  it("normalizes IPFS images and rejects unsafe media URLs", async () => {
    fetchMock.mockResolvedValueOnce(
      respond([
        nft({
          image: { cachedUrl: "javascript:alert(1)", originalUrl: "ipfs://bafy-test/art.png" },
        }),
        nft({
          tokenId: "8",
          image: {
            cachedUrl: "https://127.0.0.1/a",
            thumbnailUrl: "https://user:pass@example.com/a",
            originalUrl: "data:image/svg+xml,svg",
          },
        }),
      ]),
    );
    expect((await getMarketplaceWalletNfts(owner)).items.map((item) => item.image)).toEqual([
      "https://magic.decentralized-content.com/ipfs/bafy-test/art.png",
      null,
    ]);
  });

  it.each(["invalid", zeroAddress, "vitalik.eth"])(
    "rejects invalid owner %s before fetching",
    async (address) => {
      await expect(getMarketplaceWalletNfts(address)).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["", "a".repeat(1025), "bad\ncursor"])(
    "rejects invalid cursor before fetching",
    async (cursor) => {
      await expect(getMarketplaceWalletNfts(owner, cursor)).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500])(
    "surfaces provider HTTP %s without leaking secrets",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("server-secret", { status }));
      await expect(getMarketplaceWalletNfts(owner)).rejects.toMatchObject({
        status: 503,
        code: "MARKETPLACE_UNAVAILABLE",
        retryable: true,
        message: "Wallet NFTs could not be loaded. Try again.",
      });
    },
  );

  it("fails explicitly when the server key is absent", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_ALCHEMY_API_KEY", "public-key");
    await expect(getMarketplaceWalletNfts(owner)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { error: "provider failure" },
    { ownedNfts: [nft({ tokenId: "-1" })] },
    { ownedNfts: [], pageKey: "x".repeat(1025) },
  ])("rejects malformed provider pages", async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(getMarketplaceWalletNfts(owner)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects oversized responses and repeated cursors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2_000_001)));
    await expect(getMarketplaceWalletNfts(owner)).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(respond([], "same"));
    await expect(getMarketplaceWalletNfts(owner, "same")).rejects.toMatchObject({ status: 503 });
  });

  it("does not retain failures in the pending request cache", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout https://provider/server-secret"));
    await expect(getMarketplaceWalletNfts(owner)).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(respond());
    expect((await getMarketplaceWalletNfts(owner)).items).toHaveLength(1);
  });
});
