import {
  decodeFunctionData,
  hashStruct,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  buildOpenSeaListingQuote,
  getOpenSeaCancellation,
  parseOpenSeaListingFees,
  validateOpenSeaListingFees,
} from "./opensea-listing";
import {
  orderTypes,
  orderValues,
  SEAPORT_ADDRESS,
  seaportAbi,
  type SignedListing,
} from "./seaport";

const seller = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const otherRecipient = "0x3333333333333333333333333333333333333333" as Address;
function collection() {
  return {
    collection: "gnars-dao",
    contracts: [{ address: DAO_ADDRESSES.token, chain: "base" }],
    fees: [
      { recipient, fee: 1, required: true },
      { recipient: otherRecipient, fee: 4.2, required: false },
    ],
  };
}
function listing(): SignedListing {
  const now = Math.floor(Date.now() / 1000);
  return {
    parameters: {
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
          startAmount: "9900",
          endAmount: "9900",
          recipient: seller,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "100",
          endAmount: "100",
          recipient,
        },
      ],
      orderType: 0,
      startTime: String(now - 60),
      endTime: String(now + 86400),
      zoneHash: zeroHash,
      salt: "42",
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0x11",
  };
}
function externalOrder(orderType = 0) {
  const parameters = {
    ...listing().parameters,
    orderType,
    zone: otherRecipient,
    conduitKey: `0x${"55".repeat(32)}` as Hex,
    salt: "0x2a",
    startTime: "1",
    endTime: "31536001",
  };
  const orderHash = hashStruct({
    data: { ...orderValues({ ...parameters, orderType: 0 }), orderType },
    types: orderTypes,
    primaryType: "OrderComponents",
  });
  return {
    chain: "base",
    order_hash: orderHash,
    protocol_address: SEAPORT_ADDRESS,
    protocol_data: { parameters },
  };
}

describe("OpenSea listing fee quotes", () => {
  it("uses provider-required fees only and excludes optional creator fees", () => {
    expect(parseOpenSeaListingFees(collection())).toEqual([{ recipient, basisPoints: 100 }]);
    const quote = buildOpenSeaListingQuote("10000", parseOpenSeaListingFees(collection()));
    expect(quote).toEqual({
      priceWei: "10000",
      sellerWei: "9900",
      fees: [{ recipient, basisPoints: 100, amountWei: "100" }],
    });
    expect(() => validateOpenSeaListingFees(listing(), quote)).not.toThrow();
  });
  it("does not hardcode a provider percentage or recipient", () => {
    const raw = collection();
    raw.fees = [{ fee: 4.2, recipient: otherRecipient, required: true }];
    expect(parseOpenSeaListingFees(raw)).toEqual([{ recipient: otherRecipient, basisPoints: 420 }]);
  });
  it.each(["slug", "chain", "contract", "zone", "missingFees", "unknownRequired"])(
    "rejects unsupported collection metadata: %s",
    (field) => {
      const raw: Record<string, unknown> = collection();
      if (field === "slug") raw.collection = "other";
      if (field === "chain") raw.contracts = [{ address: DAO_ADDRESSES.token, chain: "ethereum" }];
      if (field === "contract") raw.contracts = [{ address: recipient, chain: "base" }];
      if (field === "zone") raw.required_zone = recipient;
      if (field === "missingFees") delete raw.fees;
      if (field === "unknownRequired") raw.fees = [{ recipient, fee: 1 }];
      expect(() => parseOpenSeaListingFees(raw)).toThrow();
    },
  );
  it.each([-1, 100, 101, 0.001, 1.234, Infinity, NaN, "1e2", "0.00001", "not-a-number"])(
    "rejects invalid required fee %s",
    (fee) => {
      expect(() =>
        parseOpenSeaListingFees({ ...collection(), fees: [{ recipient, fee, required: true }] }),
      ).toThrow();
    },
  );
  it("parses exact decimal basis points and permits zero required fees without a payment item", () => {
    expect(
      parseOpenSeaListingFees({
        ...collection(),
        required_zone: zeroAddress,
        fees: [{ recipient, fee: "1.0100", required: true }],
      }),
    ).toEqual([{ recipient, basisPoints: 101 }]);
    expect(
      parseOpenSeaListingFees({ ...collection(), fees: [{ recipient, fee: 0, required: true }] }),
    ).toEqual([]);
    expect(buildOpenSeaListingQuote("1", [])).toEqual({ priceWei: "1", sellerWei: "1", fees: [] });
  });
  it("calculates each fee with integer floor and subtracts the exact total", () => {
    expect(
      buildOpenSeaListingQuote("10001", [
        { recipient, basisPoints: 333 },
        { recipient: otherRecipient, basisPoints: 777 },
      ]),
    ).toEqual({
      priceWei: "10001",
      sellerWei: "8891",
      fees: [
        { recipient, basisPoints: 333, amountWei: "333" },
        { recipient: otherRecipient, basisPoints: 777, amountWei: "777" },
      ],
    });
  });
  it("rejects tiny fees, overflowing prices, zero recipients, too many items, and confiscatory totals", () => {
    expect(() => buildOpenSeaListingQuote("1", [{ recipient, basisPoints: 1 }])).toThrow(
      "too small",
    );
    expect(() => buildOpenSeaListingQuote("0", [])).toThrow("positive");
    expect(() => buildOpenSeaListingQuote((2n ** 256n).toString(), [])).toThrow();
    expect(() =>
      buildOpenSeaListingQuote("10000", [{ recipient: zeroAddress, basisPoints: 1 }]),
    ).toThrow();
    expect(() =>
      buildOpenSeaListingQuote(
        "10000",
        Array.from({ length: 10 }, () => ({ recipient, basisPoints: 1 })),
      ),
    ).toThrow();
    expect(() =>
      buildOpenSeaListingQuote("10000", [
        { recipient, basisPoints: 5000 },
        { recipient: otherRecipient, basisPoints: 5000 },
      ]),
    ).toThrow("entire price");
  });
  it.each(["recipient", "amount", "seller", "extra", "missing", "quoteSeller", "quoteFee"])(
    "rejects a signed order or quote with changed %s",
    (field) => {
      const order = listing();
      const quote = buildOpenSeaListingQuote("10000", [{ recipient, basisPoints: 100 }]);
      if (field === "recipient") order.parameters.consideration[1].recipient = otherRecipient;
      if (field === "amount")
        Object.assign(order.parameters.consideration[1], { startAmount: "101", endAmount: "101" });
      if (field === "seller")
        Object.assign(order.parameters.consideration[0], {
          startAmount: "9899",
          endAmount: "9899",
        });
      if (field === "extra")
        order.parameters.consideration.push({ ...order.parameters.consideration[1] });
      if (field === "missing") order.parameters.consideration.pop();
      if (field === "quoteSeller") quote.sellerWei = "9999";
      if (field === "quoteFee") quote.fees[0].amountWei = "1";
      expect(() => validateOpenSeaListingFees(order, quote)).toThrow();
    },
  );
});

describe("external OpenSea order cancellation", () => {
  it.each([0, 1, 2, 3])(
    "cancels exact order type %s without conflating it with authored orders",
    (orderType) => {
      const order = externalOrder(orderType);
      const call = getOpenSeaCancellation(
        { order },
        { orderHash: order.order_hash, seller, tokenId: "42" },
      );
      expect(call.to).toBe(SEAPORT_ADDRESS);
      expect(call.value).toBe(0n);
      const decoded = decodeFunctionData({ abi: seaportAbi, data: call.data });
      expect(decoded.functionName).toBe("cancel");
      if (decoded.functionName !== "cancel") throw new Error("wrong function");
      const components = decoded.args[0][0];
      expect(components.orderType).toBe(orderType);
      expect(components.zone).toBe(otherRecipient);
      expect(components.salt).toBe(42n);
      expect(components.conduitKey).toBe(order.protocol_data.parameters.conduitKey);
      expect(
        hashStruct({ data: components, primaryType: "OrderComponents", types: orderTypes }),
      ).toBe(order.order_hash);
    },
  );
  it.each([
    "chain",
    "protocol",
    "seller",
    "tokenId",
    "hash",
    "counter",
    "collection",
    "quantity",
    "currency",
    "dynamic",
    "missingCounter",
    "unsafeNumber",
  ])("rejects mismatched or unsupported cancellation %s", (field) => {
    const order = externalOrder();
    const p = order.protocol_data.parameters;
    const expected = { orderHash: order.order_hash, seller, tokenId: "42" };
    if (field === "chain") order.chain = "ethereum";
    if (field === "protocol") Object.assign(order, { protocol_address: recipient });
    if (field === "seller") expected.seller = recipient;
    if (field === "tokenId") expected.tokenId = "43";
    if (field === "hash") expected.orderHash = zeroHash;
    if (field === "counter") p.counter = "1";
    if (field === "collection") p.offer[0].token = recipient;
    if (field === "quantity") p.offer[0].startAmount = "2";
    if (field === "currency") p.consideration[0].itemType = 1;
    if (field === "dynamic") p.consideration[0].endAmount = "123";
    if (field === "missingCounter") Reflect.deleteProperty(p, "counter");
    if (field === "unsafeNumber") Object.assign(p, { salt: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => getOpenSeaCancellation(order, expected)).toThrow();
  });
});
