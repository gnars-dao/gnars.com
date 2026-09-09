import { describe, expect, it } from "vitest";
import {
  parseClankerDirectory,
  parseZoraDirectory,
  swapTokenDirectorySchema,
} from "./swap-token-directory";

const address = "0x1111111111111111111111111111111111111111";
const zora = () => ({
  exploreList: {
    edges: [
      {
        node: {
          address,
          name: "Creator",
          symbol: "CREATOR",
          chainId: 8453,
          mediaContent: { previewImage: { small: "https://example.com/coin.png" } },
        },
      },
    ],
  },
});
const clanker = () => ({
  data: [
    {
      contract_address: address,
      name: "Community",
      symbol: "COMM",
      chain_id: 8453,
      type: "clanker_v4",
      factory_address: address,
      img_url: "https://example.com/coin.png",
    },
  ],
});

describe("verified swap token directory normalization", () => {
  it("uses official Zora provenance, fixed protocol decimals and bounded metadata", () => {
    expect(parseZoraDirectory(zora())).toEqual([
      {
        address,
        name: "Creator",
        symbol: "CREATOR",
        decimals: 18,
        logo: "https://example.com/coin.png",
        category: "creator",
        source: "zora",
        sourceUrl: `https://zora.co/coin/base:${address}`,
      },
    ]);
  });
  it("uses Clanker deployment type rather than stock-like token symbols", () => {
    const raw = clanker();
    raw.data[0].symbol = "TSLAx";
    expect(parseClankerDirectory(raw)[0]).toMatchObject({
      category: "creator",
      source: "clanker",
      symbol: "TSLAx",
    });
    raw.data[0].type = "unknown-token";
    expect(parseClankerDirectory(raw)).toEqual([]);
  });
  it("never includes tokens from another chain", () => {
    const a = zora();
    a.exploreList.edges[0].node.chainId = 1;
    const b = clanker();
    b.data[0].chain_id = 42161;
    expect(parseZoraDirectory(a)).toEqual([]);
    expect(parseClankerDirectory(b)).toEqual([]);
  });
  it("deduplicates and omits unsafe logo schemes", () => {
    const raw = zora();
    raw.exploreList.edges[0].node.mediaContent.previewImage.small = "javascript:alert(1)";
    raw.exploreList.edges.push(raw.exploreList.edges[0]);
    expect(parseZoraDirectory(raw)).toHaveLength(1);
    expect(parseZoraDirectory(raw)[0].logo).toBeUndefined();
  });
  it("rejects malformed provider data instead of reporting a successful empty list", () => {
    expect(() => parseZoraDirectory({})).toThrow();
    expect(() => parseClankerDirectory({ error: "unavailable" })).toThrow();
    const invalid = clanker();
    invalid.data[0].contract_address = "not-an-address";
    expect(() => parseClankerDirectory(invalid)).toThrow();
    const large = zora();
    large.exploreList.edges = Array(21).fill(large.exploreList.edges[0]);
    expect(() => parseZoraDirectory(large)).toThrow();
  });
  it("truncates long provider names without losing the rest of the feed", () => {
    const raw = zora();
    raw.exploreList.edges[0].node.name = "a".repeat(2000);
    const tokens = parseZoraDirectory(raw);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].name).toHaveLength(512);
    const other = clanker();
    other.data[0].name = "b".repeat(4096);
    expect(parseClankerDirectory(other)[0].name).toHaveLength(512);
    raw.exploreList.edges[0].node.name = "a" + "\u{1f3c4}".repeat(300);
    expect(parseZoraDirectory(raw)[0].name).toHaveLength(511);
  });

  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "//attacker.example/logo.png",
    "http://example.com/logo.png",
  ])("rejects an unsafe directory logo %s", (logo) => {
    expect(
      swapTokenDirectorySchema.safeParse({
        tokens: [{ ...parseZoraDirectory(zora())[0], logo }],
        sources: {
          zora: { available: true },
          clanker: { available: true },
          stocks: { available: true },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts verified Coinbase stock metadata and the local Gnars logo", () => {
    expect(
      swapTokenDirectorySchema.safeParse({
        tokens: [
          {
            ...parseZoraDirectory(zora())[0],
            logo: "/gnars.webp",
            category: "stock",
            source: "coinbase",
          },
        ],
        sources: {
          zora: { available: true },
          clanker: { available: true },
          stocks: { available: true },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects invalid category/source combinations at the client boundary", () => {
    expect(
      swapTokenDirectorySchema.safeParse({
        tokens: [{ ...parseZoraDirectory(zora())[0], category: "stock" }],
        sources: {
          zora: { available: true },
          clanker: { available: true },
          stocks: { available: true },
        },
      }).success,
    ).toBe(false);
  });
});
