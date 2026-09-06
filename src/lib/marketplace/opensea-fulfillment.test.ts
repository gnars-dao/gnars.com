import { hashStruct, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceOffer } from "@/types/marketplace";
import { encodeOpenSeaFulfillment, verifyOpenSeaTransaction } from "./opensea-fulfillment";
import { orderTypes, SEAPORT_ADDRESS } from "./seaport";

const seller = "0x1111111111111111111111111111111111111111" as Address;
const buyer = "0x2222222222222222222222222222222222222222" as Address;
function fixture(kind: "basic" | "order" | "advanced" = "advanced") {
  const p = {
    offerer: seller,
    zone: zeroAddress,
    offer: [
      {
        itemType: 2,
        token: DAO_ADDRESSES.token,
        identifierOrCriteria: "42",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "100",
        endAmount: "100",
        recipient: seller,
      },
    ],
    orderType: 0,
    startTime: "1",
    endTime: "9999999999",
    zoneHash: zeroHash,
    salt: "123",
    conduitKey: zeroHash,
    counter: "0",
    totalOriginalConsiderationItems: "1",
  };
  const hash = hashStruct({ data: p, primaryType: "OrderComponents", types: orderTypes });
  const offer: MarketplaceOffer = {
    id: hash,
    orderHash: hash,
    source: "opensea",
    protocolAddress: SEAPORT_ADDRESS,
    seller,
    priceWei: "100",
    currency: "ETH",
    expiresAt: 9999999999,
  };
  const order = { parameters: p, signature: "0x1234" };
  const basic = {
    considerationToken: zeroAddress,
    considerationIdentifier: "0",
    considerationAmount: "100",
    offerer: seller,
    zone: zeroAddress,
    offerToken: DAO_ADDRESSES.token,
    offerIdentifier: "42",
    offerAmount: "1",
    basicOrderType: 0,
    startTime: "1",
    endTime: "9999999999",
    zoneHash: zeroHash,
    salt: "123",
    offererConduitKey: zeroHash,
    fulfillerConduitKey: zeroHash,
    totalOriginalAdditionalRecipients: "0",
    additionalRecipients: [],
    signature: "0x1234",
  };
  const input_data =
    kind === "basic"
      ? { parameters: basic }
      : kind === "order"
        ? { order, fulfillerConduitKey: zeroHash }
        : {
            advancedOrder: { ...order, numerator: 1, denominator: 1, extraData: "0x" },
            criteriaResolvers: [],
            fulfillerConduitKey: zeroHash,
            recipient: buyer,
          };
  const raw = {
    protocol: "seaport",
    fulfillment_data: {
      orders: [order],
      transaction: {
        chain: 8453,
        to: SEAPORT_ADDRESS as Address,
        value: "100",
        function:
          kind === "basic"
            ? "fulfillBasicOrder"
            : kind === "order"
              ? "fulfillOrder"
              : "fulfillAdvancedOrder",
        input_data,
      },
    },
  };
  return { raw, expected: { offer, tokenId: "42", buyer }, p };
}
describe("OpenSea fulfillment boundary", () => {
  it("accepts the documented ABI Address wrapper for the buyer", () => {
    const { raw, expected } = fixture();
    Object.assign(raw.fulfillment_data.transaction.input_data, {
      recipient: { value: buyer, typeAsString: "address" },
    });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).not.toThrow();
  });
  it.each(["basic", "order", "advanced"] as const)(
    "encodes and independently verifies %s",
    (kind) => {
      const { raw, expected } = fixture(kind);
      const tx = encodeOpenSeaFulfillment(raw, expected);
      expect(tx.value).toBe(100n);
      expect(() => verifyOpenSeaTransaction(tx, { ...expected, counter: 0n })).not.toThrow();
      expect(() => verifyOpenSeaTransaction(tx, { ...expected, counter: 1n })).toThrow(
        "hash mismatch",
      );
    },
  );
  it.each(["to", "value", "chain", "function"])("rejects changed transaction %s", (field) => {
    const { raw, expected } = fixture();
    Object.assign(raw.fulfillment_data.transaction, {
      [field]:
        field === "to" ? buyer : field === "value" ? "101" : field === "chain" ? 1 : "matchOrders",
    });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow();
  });
  it.each(["token", "identifierOrCriteria", "startAmount"])(
    "rejects a substituted NFT %s",
    (field) => {
      const { raw, expected, p } = fixture();
      Object.assign(p.offer[0], { [field]: field === "token" ? buyer : "2" });
      expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow();
    },
  );
  it("rejects a substituted recipient and buyer conduit", () => {
    const { raw, expected } = fixture();
    Object.assign(raw.fulfillment_data.transaction.input_data, { recipient: seller });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow("route");
    Object.assign(raw.fulfillment_data.transaction.input_data, {
      recipient: buyer,
      fulfillerConduitKey: `0x${"11".repeat(32)}`,
    });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow("route");
  });
  it("rejects appended consideration and partial fills", () => {
    const { raw, expected, p } = fixture();
    p.consideration.push({ ...p.consideration[0] });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow();
    const next = fixture();
    Object.assign(next.raw.fulfillment_data.transaction.input_data, {
      advancedOrder: {
        parameters: next.p,
        signature: "0x1234",
        numerator: 1,
        denominator: 2,
        extraData: "0x",
      },
    });
    expect(() => encodeOpenSeaFulfillment(next.raw, next.expected)).toThrow();
  });
  it("rejects unsafe numeric JSON values and arbitrary calldata", () => {
    const { raw, expected } = fixture();
    Object.assign(raw.fulfillment_data.orders[0].parameters, { salt: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => encodeOpenSeaFulfillment(raw, expected)).toThrow();
    expect(() =>
      verifyOpenSeaTransaction(
        { to: SEAPORT_ADDRESS, value: 100n, data: "0xdeadbeef" as Hex },
        { ...expected, counter: 0n },
      ),
    ).toThrow();
  });
});
