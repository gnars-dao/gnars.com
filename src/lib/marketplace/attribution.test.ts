import { recoverTypedDataAddress, stringToHex, toHex, zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILDER_CODE, DAO_ADDRESSES } from "@/lib/config";
import { generateMarketplaceSalt } from "./attribution";
import { getListingTypedData, type OrderComponents } from "./seaport";

afterEach(() => vi.restoreAllMocks());

describe("marketplace signed-order attribution", () => {
  it("encodes the builder code as the leading bytes of a decimal uint256 salt", () => {
    const salt = generateMarketplaceSalt();
    expect(salt).toMatch(/^\d+$/);
    expect(BigInt(salt)).toBeGreaterThan(0n);
    expect(BigInt(salt)).toBeLessThan(2n ** 256n);
    const hex = toHex(BigInt(salt), { size: 32 });
    expect(hex).toHaveLength(66);
    expect(hex.startsWith(stringToHex(BUILDER_CODE))).toBe(true);
  });

  it("fills all remaining 21 bytes with cryptographically secure randomness", () => {
    const random = vi.spyOn(crypto, "getRandomValues");
    const salts = Array.from({ length: 32 }, generateMarketplaceSalt);
    expect(new Set(salts).size).toBe(salts.length);
    expect(random).toHaveBeenCalledTimes(salts.length);
    for (const [bytes] of random.mock.calls) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes?.byteLength).toBe(21);
    }
  });

  it("keeps the standard Seaport signature valid and binds its builder-coded salt", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const parameters: OrderComponents = {
      offerer: account.address,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: "5351",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "20000000000000000",
          endAmount: "20000000000000000",
          recipient: account.address,
        },
      ],
      orderType: 0,
      startTime: "1788754349",
      endTime: "1789359179",
      zoneHash: zeroHash,
      salt: generateMarketplaceSalt(),
      conduitKey: zeroHash,
      counter: "0",
    };
    const typedData = getListingTypedData(parameters);
    const signature = await account.signTypedData(typedData);
    expect(signature).toHaveLength(132);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address);
    expect(
      await recoverTypedDataAddress({
        ...getListingTypedData({ ...parameters, salt: "1" }),
        signature,
      }),
    ).not.toBe(account.address);
  });
});
