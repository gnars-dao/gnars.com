import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  parseClankerTokenSource,
  parseTokenSourceAddresses,
  parseZoraTokenSources,
  swapTokenSourcesSchema,
} from "./swap-token-sources";

const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const clanker = { contract_address: a, chain_id: 8453, factory_address: b, type: "clanker_v4" };
describe("wallet creator-token provenance", () => {
  it("canonicalizes and deduplicates only bounded Base address requests", () => {
    expect(
      parseTokenSourceAddresses(
        new URLSearchParams({ chainId: "8453", addresses: `${b},${a},${b}` }),
      ),
    ).toEqual([a, b]);
    for (const query of [
      "chainId=1&addresses=" + a,
      "chainId=8453&addresses=" + zeroAddress,
      "chainId=8453&addresses=invalid",
      "chainId=8453&addresses=",
      "chainId=8453&addresses=" + Array(26).fill(a).join(","),
      `chainId=8453&addresses=${a}&addresses=${b}`,
      `chainId=8453&addresses=${a}&url=https://evil.example`,
    ]) {
      expect(() => parseTokenSourceAddresses(new URLSearchParams(query))).toThrow();
    }
  });
  it("accepts only requested Zora addresses on Base and deduplicates", () => {
    expect(
      parseZoraTokenSources(
        {
          zora20Tokens: [
            { address: b, chainId: 8453 },
            { address: a, chainId: 1 },
            { address: a, chainId: 8453 },
            { address: a, chainId: 8453 },
          ],
        },
        [a],
      ),
    ).toEqual([{ address: a, source: "zora" }]);
    expect(() => parseZoraTokenSources({ zora20Tokens: [{ address: a }] }, [a])).toThrow();
    expect(() => parseZoraTokenSources({}, [a])).toThrow();
  });
  it("accepts null entries as non-Zora contracts without accepting malformed objects", () => {
    expect(
      parseZoraTokenSources({ zora20Tokens: [{ address: a, chainId: 8453 }, null] }, [a, b]),
    ).toEqual([{ address: a, source: "zora" }]);
    expect(parseZoraTokenSources({ zora20Tokens: [null] }, [b])).toEqual([]);
    expect(() => parseZoraTokenSources({ zora20Tokens: [null, { address: a }] }, [a, b])).toThrow();
  });
  it("does not infer Clanker from names, suffixes, other chains, or unsupported deployments", () => {
    expect(parseClankerTokenSource({ data: [clanker] }, a)).toEqual({
      address: a,
      source: "clanker",
    });
    for (const token of [
      { ...clanker, contract_address: b },
      { ...clanker, chain_id: 1 },
      { ...clanker, type: "unverified" },
    ]) {
      expect(parseClankerTokenSource({ data: [token] }, a)).toBeNull();
    }
    expect(() =>
      parseClankerTokenSource({ data: [{ ...clanker, factory_address: zeroAddress }] }, a),
    ).toThrow();
    expect(() => parseClankerTokenSource({ error: "unavailable" }, a)).toThrow();
  });
  it("exposes only verified source metadata, not replacement balances or decimals", () => {
    expect(
      swapTokenSourcesSchema.parse({
        tokens: [{ address: a, source: "zora", decimals: 8, balance: "99" }],
        complete: true,
      }),
    ).toEqual({ tokens: [{ address: a, source: "zora" }], complete: true });
    expect(
      swapTokenSourcesSchema.safeParse({
        tokens: [{ address: a, source: "coinbase" }],
        complete: true,
      }).success,
    ).toBe(false);
  });
  it("recognizes legacy proxy deployments only from documented Clanker Base factories", () => {
    for (const factory_address of [
      "0x250c9FB2b411B48273f69879007803790A6AeA47",
      "0x9B84fcE5Dcd9a38d2D01d5D72373F6b6b067c3e1",
      "0x732560fa1d1A76350b1A500155BA978031B53833",
    ]) {
      expect(
        parseClankerTokenSource({ data: [{ ...clanker, type: "proxy", factory_address }] }, a),
      ).toEqual({ address: a, source: "clanker" });
    }
    expect(parseClankerTokenSource({ data: [{ ...clanker, type: "proxy" }] }, a)).toBeNull();
  });
});
