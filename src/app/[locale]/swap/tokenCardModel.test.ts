import { describe, expect, it } from "vitest";
import { VERIFIED_BASE_STOCK_TOKENS } from "@/data/swap-stock-tokens";
import { NATIVE_TOKEN, SWAP_CHAINS, type SwapToken } from "./chains";
import { type ZoraCoinLike } from "./coinCardModel";
import { shouldFetchTokenMetadata, tokenCardIdentity } from "./tokenCardModel";

const address = "0x1111111111111111111111111111111111111111" as const;
const token: SwapToken = { address, name: "Example Token", symbol: "EXAMPLE", decimals: 18 };
const coin: ZoraCoinLike = { address, name: "Example Token", symbol: "EXAMPLE" };
const nvda = VERIFIED_BASE_STOCK_TOKENS.find((entry) => entry.symbol === "NVDAc")!;

describe("tokenCardIdentity", () => {
  it("recognizes NVDAc by its Base registry address even with generic contractURI metadata", () => {
    const identity = tokenCardIdentity({ ...token, address: nvda.address, symbol: "NVDAc" }, 8453, {
      coin: { ...coin, address: nvda.address },
      source: "onchain",
    });

    expect(identity).toMatchObject({ kind: "stock", link: "explorer", label: null });
    expect(identity.href).toMatch(/^https:\/\/basescan\.org\/token\//);
    expect(identity.href?.toLowerCase()).toContain(nvda.address.toLowerCase());
    expect(identity.href).not.toContain("zora.co");
  });

  it("gives the verified stock registry precedence over stale Zora provenance", () => {
    expect(
      tokenCardIdentity({ ...nvda, source: "zora", category: "creator" }, 8453, {
        coin: { ...coin, address: nvda.address },
        source: "zora",
      }),
    ).toMatchObject({ kind: "stock", link: "explorer", label: null });
  });

  it("matches stock addresses case-insensitively without relying on a ticker", () => {
    expect(
      tokenCardIdentity({ ...token, address: nvda.address.toLowerCase() as `0x${string}` }, 8453)
        .kind,
    ).toBe("stock");
    expect(tokenCardIdentity({ ...token, name: nvda.name, symbol: "NVDAc" }, 8453)).toMatchObject({
      kind: "token",
      label: "Base",
      link: "explorer",
    });
  });

  it("never interprets arbitrary contractURI metadata as Zora provenance", () => {
    expect(tokenCardIdentity(token, 8453, { coin, source: "onchain" })).toEqual({
      kind: "token",
      href: `https://basescan.org/token/${address}`,
      link: "explorer",
      label: "Base",
    });
  });

  it("uses Zora provenance supplied by validated metadata", () => {
    expect(tokenCardIdentity(token, 8453, { coin, source: "zora" })).toEqual({
      kind: "zora",
      href: `https://zora.co/coin/base:${address}`,
      link: "zora",
      label: null,
    });
  });

  it("preserves known Zora identity while enrichment is missing or unavailable", () => {
    const zoraToken: SwapToken = { ...token, category: "creator", source: "zora" };
    expect(tokenCardIdentity(zoraToken, 8453).kind).toBe("zora");
    expect(tokenCardIdentity(zoraToken, 8453, { coin: null, source: null }).kind).toBe("zora");
  });

  it("links a verified Clanker token to Clanker even when generic metadata exists", () => {
    expect(
      tokenCardIdentity({ ...token, category: "creator", source: "clanker" }, 8453, {
        coin,
        source: "onchain",
      }),
    ).toEqual({
      kind: "clanker",
      href: `https://www.clanker.world/clanker/${address}`,
      link: "clanker",
      label: null,
    });
  });

  it("does not transfer Base stock identity or cached Zora provenance to Ethereum", () => {
    const identity = tokenCardIdentity(nvda, 1, {
      coin: { ...coin, address: nvda.address },
      source: "zora",
    });
    expect(identity).toMatchObject({ kind: "token", label: "Ethereum", link: "explorer" });
    expect(identity.href).toMatch(/^https:\/\/etherscan\.io\/token\//);
  });

  it("does not transfer Base Clanker identity to another chain", () => {
    expect(
      tokenCardIdentity({ ...token, category: "creator", source: "clanker" }, 42161),
    ).toMatchObject({ kind: "token", label: "Arbitrum", link: "explorer" });
  });

  it.each(SWAP_CHAINS.map((chain) => [chain.name, chain.id] as const))(
    "renders native currency identity with a chain explorer root on %s",
    (name, chainId) => {
      const identity = tokenCardIdentity({ ...token, address: NATIVE_TOKEN }, chainId);
      expect(identity).toMatchObject({ kind: "native", label: name, link: "explorer" });
      expect(identity.href).toMatch(/^https:\/\//);
      expect(identity.href).not.toContain("/token/");
      expect(identity.href).not.toContain(NATIVE_TOKEN);
    },
  );

  it("keeps an ordinary ERC20 card identifiable without enriched metadata", () => {
    expect(tokenCardIdentity(token, 8453)).toEqual({
      kind: "token",
      href: `https://basescan.org/token/${address}`,
      link: "explorer",
      label: "Base",
    });
  });
});

describe("shouldFetchTokenMetadata", () => {
  it("does not query Zora for a known stock even without picker provenance", () => {
    expect(shouldFetchTokenMetadata(nvda, 8453)).toBe(false);
    expect(shouldFetchTokenMetadata({ ...token, address: nvda.address }, 8453)).toBe(false);
    expect(shouldFetchTokenMetadata({ ...nvda, category: "creator", source: "zora" }, 8453)).toBe(
      false,
    );
  });

  it.each(["clanker", "coinbase", "ondo", "xstocks"] as const)(
    "does not query Zora for explicit %s provenance",
    (source) => {
      expect(shouldFetchTokenMetadata({ ...token, source }, 8453)).toBe(false);
    },
  );

  it("does not query metadata for native currency on any supported chain", () => {
    for (const chain of SWAP_CHAINS) {
      expect(shouldFetchTokenMetadata({ ...token, address: NATIVE_TOKEN }, chain.id)).toBe(false);
    }
  });

  it("does not query Zora for any static curated Base token", () => {
    const base = SWAP_CHAINS.find((chain) => chain.id === 8453)!;
    for (const curatedToken of base.tokens) {
      expect(shouldFetchTokenMetadata(curatedToken, base.id), curatedToken.symbol).toBe(false);
      expect(
        shouldFetchTokenMetadata(
          { ...curatedToken, address: curatedToken.address.toLowerCase() as `0x${string}` },
          base.id,
        ),
        curatedToken.symbol,
      ).toBe(false);
    }
  });

  it("enriches known Zora coins and still discovers unknown Base tokens", () => {
    expect(shouldFetchTokenMetadata({ ...token, category: "creator", source: "zora" }, 8453)).toBe(
      true,
    );
    expect(shouldFetchTokenMetadata(token, 8453)).toBe(true);
    expect(shouldFetchTokenMetadata({ ...token, symbol: "NVDAc" }, 8453)).toBe(true);
  });

  it.each([1, 42161, 56, 43114, 4663, 999999])(
    "never makes a Base-only metadata request on chain %s",
    (chainId) => {
      expect(shouldFetchTokenMetadata(token, chainId)).toBe(false);
      expect(shouldFetchTokenMetadata({ ...token, source: "zora" }, chainId)).toBe(false);
    },
  );
});
