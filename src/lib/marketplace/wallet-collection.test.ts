import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseWalletCollection } from "./wallet-collection";

const collection = "0x9580c826076bcba116ce4729ec243290c2e3b441";

describe("wallet collection search", () => {
  it("normalizes addresses and Base OpenSea item links", () => {
    for (const input of [
      ` ${collection} `,
      `https://opensea.io/item/base/${collection}/54`,
      `https://www.opensea.io/assets/base/${collection}/54/?ref=share`,
    ])
      expect(parseWalletCollection(input)).toBe(getAddress(collection));
  });
  it.each([
    "",
    "SkateHive",
    "0xfe10",
    zeroAddress,
    `https://opensea.io/item/ethereum/${collection}/54`,
    `https://example.com/item/base/${collection}/54`,
    `https://opensea.io.evil.test/item/base/${collection}/54`,
    `https://user:password@opensea.io/item/base/${collection}/54`,
    `http://opensea.io/item/base/${collection}/54`,
  ])("rejects invalid or non-Base search %s", (input) => {
    expect(parseWalletCollection(input)).toBeNull();
  });
});
