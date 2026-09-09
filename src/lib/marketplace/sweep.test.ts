import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { GNARS_MARKETPLACE_FEE_POLICY } from "./community-policy";
import { getListingOrderHash, type SignedListing } from "./seaport";
import { getSweepFulfillment, getSweepResults, sweepAbi } from "./sweep";

const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
function listing(tokenId = "42"): SignedListing {
  const now = Math.floor(Date.now() / 1000);
  return {
    parameters: {
      offerer: seller,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: tokenId,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "990",
          endAmount: "990",
          recipient: seller,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "10",
          endAmount: "10",
          recipient: GNARS_MARKETPLACE_FEE_POLICY.recipient,
        },
      ],
      orderType: 0,
      startTime: String(now - 10),
      endTime: String(now + 86400),
      zoneHash: zeroHash,
      salt: tokenId,
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0xabcd",
  };
}
function receipt(order: SignedListing, recipient: Address = buyer, paymentDelta = 0n) {
  const event = sweepAbi.find((item) => item.type === "event")!;
  return {
    address: protocol as Address,
    topics: encodeEventTopics({
      abi: sweepAbi,
      eventName: "OrderFulfilled",
      args: { offerer: seller, zone: zeroAddress },
    }) as Hex[],
    data: encodeAbiParameters(
      event.inputs.filter((input) => !("indexed" in input && input.indexed)),
      [
        getListingOrderHash(order.parameters),
        recipient,
        order.parameters.offer.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifier: BigInt(item.identifierOrCriteria),
          amount: BigInt(item.startAmount),
        })),
        order.parameters.consideration.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifier: BigInt(item.identifierOrCriteria),
          amount: BigInt(item.startAmount) + paymentDelta,
          recipient: item.recipient,
        })),
      ],
    ),
  };
}
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol));
afterEach(() => vi.unstubAllEnvs());
describe("Gnars native ETH sweep", () => {
  it("encodes one canonical call preserving signatures, all fees, royalty and fulfillment indexes", () => {
    const first = listing(),
      second = listing("43");
    second.parameters.consideration.push({
      ...second.parameters.consideration[0],
      recipient: buyer,
      startAmount: "50",
      endAmount: "50",
    });
    const tx = getSweepFulfillment([first, second]);
    expect(tx.to).toBe(protocol);
    expect(tx.value).toBe(2050n);
    const decoded = decodeFunctionData({ abi: sweepAbi, data: tx.data });
    expect(decoded.functionName).toBe("fulfillAvailableOrders");
    expect(decoded.args[0].map((order) => order.signature)).toEqual(["0xabcd", "0xabcd"]);
    expect(
      decoded.args[0][1].parameters.consideration.map((item) => item.recipient.toLowerCase()),
    ).toEqual(second.parameters.consideration.map((item) => item.recipient.toLowerCase()));
    expect(decoded.args[1]).toHaveLength(2);
    expect(decoded.args[2]).toHaveLength(5);
    expect(decoded.args[3]).toBe(zeroHash);
    expect(decoded.args[4]).toBe(2n);
  });
  it("rejects empty, oversized, duplicate or non-native NFTs", () => {
    expect(() => getSweepFulfillment([])).toThrow("size");
    expect(() =>
      getSweepFulfillment(Array.from({ length: 11 }, (_, index) => listing(String(index)))),
    ).toThrow("size");
    expect(() => getSweepFulfillment([listing(), listing()])).toThrow("Duplicate");
    const other = listing();
    other.parameters.offer[0].token = buyer;
    expect(() => getSweepFulfillment([other])).toThrow("selected collection");
  });
  it("rejects unsupported routing and expired orders except explicit recovery", () => {
    const other = listing();
    other.parameters.zone = buyer;
    expect(() => getSweepFulfillment([other])).toThrow("routing");
    const expired = listing();
    expired.parameters.startTime = String(Math.floor(Date.now() / 1000) - 100);
    expired.parameters.endTime = String(Math.floor(Date.now() / 1000) - 1);
    expect(() => getSweepFulfillment([expired])).toThrow("expired");
    expect(getSweepFulfillment([expired], { allowExpired: true }).value).toBe(1000n);
  });
  it("reports actual partial fills and ignores unrelated contracts/orders", () => {
    const a = listing(),
      b = listing("43");
    expect(
      getSweepResults([a, b], buyer, [
        receipt(a),
        { ...receipt(b), address: buyer },
        receipt(listing("99")),
      ]),
    ).toEqual({ purchasedTokenIds: ["42"], skippedTokenIds: ["43"], spentWei: "1000" });
  });
  it("rejects duplicate event, different buyer or altered signed payment", () => {
    const a = listing();
    expect(() => getSweepResults([a], buyer, [])).toThrow("no verified purchases");
    expect(() => getSweepResults([a], buyer, [receipt(a), receipt(a)])).toThrow("reviewed");
    expect(() => getSweepResults([a], buyer, [receipt(a, seller)])).toThrow("reviewed");
    expect(() => getSweepResults([a], buyer, [receipt(a, buyer, 1n)])).toThrow("payment");
  });
});
