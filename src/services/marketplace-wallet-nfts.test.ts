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
        orderBy: "transferTime",
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

  it.each([owner, smartWallet])("filters a collection for exact owner %s", async (address) => {
    fetchMock.mockResolvedValueOnce(
      respond([nft(), nft({ contract: { address: smartWallet, tokenType: "ERC721" } })]),
    );
    const result = await getMarketplaceWalletNfts(address, undefined, collection);
    const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
    expect(params.get("owner")).toBe(getAddress(address));
    expect(params.getAll("contractAddresses[]")).toEqual([collection]);
    expect(params.get("orderBy")).toBe("transferTime");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].collectionAddress).toBe(collection);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves filtered pagination without fetching extra pages", async () => {
    fetchMock.mockResolvedValueOnce(respond([], "collection-page"));
    expect(await getMarketplaceWalletNfts(owner, undefined, collection)).toEqual({
      items: [],
      nextCursor: "collection-page",
    });
    fetchMock.mockResolvedValueOnce(respond());
    await getMarketplaceWalletNfts(owner, "collection-page", collection);
    const params = new URL(fetchMock.mock.calls[1][0]).searchParams;
    expect(params.get("pageKey")).toBe("collection-page");
    expect(params.getAll("contractAddresses[]")).toEqual([collection]);
    expect(params.get("pageSize")).toBe("24");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("isolates concurrent cache entries by owner, cursor, and collection", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    const requests = [
      getMarketplaceWalletNfts(owner),
      getMarketplaceWalletNfts(owner, undefined, collection),
      getMarketplaceWalletNfts(owner, "page", collection),
      getMarketplaceWalletNfts(smartWallet, undefined, collection),
      getMarketplaceWalletNfts(owner, undefined, smartWallet),
      getMarketplaceWalletNfts(getAddress(owner), undefined, getAddress(collection)),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(5);
    resolvers.forEach((resolve, index) => resolve(respond([], `next-${index}`)));
    const results = await Promise.all(requests);
    expect(results.map((result) => result.nextCursor)).toEqual([
      "next-0",
      "next-1",
      "next-2",
      "next-3",
      "next-4",
      "next-1",
    ]);
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

  it("reports unique eligible ERC1155 discoveries without listing them", async () => {
    const erc1155 = {
      tokenType: "ERC1155",
      contract: { address: collection, tokenType: "ERC1155" },
    };
    fetchMock.mockResolvedValueOnce(
      respond([
        nft(erc1155),
        nft(erc1155),
        nft({ ...erc1155, tokenId: "8" }),
        nft({ ...erc1155, contract: { ...erc1155.contract, isSpam: true } }),
        nft({ ...erc1155, contract: { ...erc1155.contract, spamClassifications: ["Airdrop"] } }),
        nft({ ...erc1155, contract: { ...erc1155.contract, address: DAO_ADDRESSES.token } }),
        nft({ ...erc1155, contract: { ...erc1155.contract, address: smartWallet } }),
        nft({ tokenId: "9" }),
      ]),
    );
    expect(await getMarketplaceWalletNfts(owner, undefined, collection)).toMatchObject({
      items: [{ tokenId: "9" }],
      unsupportedErc1155Count: 2,
    });
  });

  it("uses cached raw metadata images only after the normal image fields", async () => {
    fetchMock.mockResolvedValueOnce(
      respond([
        nft({ raw: { metadata: { image: "https://example.com/raw.png" } } }),
        nft({
          tokenId: "8",
          image: null,
          raw: { metadata: { image: "ipfs://bafy-test/raw.png" } },
        }),
        nft({ tokenId: "9", image: null, raw: { metadata: { image: "https://127.0.0.1/a" } } }),
        nft({ tokenId: "10", image: null, raw: { metadata: { image: "javascript:alert(1)" } } }),
        nft({
          tokenId: "11",
          image: null,
          raw: { metadata: { image: { url: "https://example.com/a" } } },
        }),
        nft({ tokenId: "12", image: null, raw: { metadata: "malformed" } }),
      ]),
    );
    expect((await getMarketplaceWalletNfts(owner)).items.map((item) => item.image)).toEqual([
      "https://example.com/art.png",
      "https://magic.decentralized-content.com/ipfs/bafy-test/raw.png",
      null,
      null,
      null,
      null,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid", zeroAddress, "", "skatehive.eth"])(
    "rejects invalid collection %s before fetching",
    async (address) => {
      await expect(getMarketplaceWalletNfts(owner, undefined, address)).rejects.toMatchObject({
        status: 400,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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
