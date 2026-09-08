import {
  decodeFunctionData,
  encodeFunctionData,
  hashStruct,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { OPENSEA_CONDUIT_KEY } from "@/lib/marketplace/routing";
import { orderTypes, SEAPORT_ADDRESS } from "@/lib/marketplace/seaport";
import type { MarketplaceOffer } from "@/types/marketplace";

const address = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform((v) => v as Address);
const abiAddress = z.union([
  address,
  z
    .object({ value: address, typeAsString: z.literal("address").optional() })
    .transform((v) => v.value),
]);
const bytes32 = z
  .string()
  .regex(/^0x[\da-fA-F]{64}$/)
  .transform((v) => v as Hex);
const bytes = z
  .string()
  .regex(/^0x(?:[\da-fA-F]{2})*$/)
  .max(32770)
  .transform((v) => v as Hex);
const uint = z
  .union([
    z.bigint(),
    z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .max(78),
    z.string().regex(/^0x[\da-fA-F]{1,64}$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((v) => BigInt(v))
  .refine((v) => v >= 0n && v < 2n ** 256n);
const item = z.object({
  itemType: z.number().int(),
  token: address,
  identifierOrCriteria: uint,
  startAmount: uint,
  endAmount: uint,
});
const parameters = z.object({
  offerer: address,
  zone: address,
  offer: z.array(item).length(1),
  consideration: z
    .array(item.extend({ recipient: address }))
    .min(1)
    .max(10),
  orderType: z.number().int(),
  startTime: uint,
  endTime: uint,
  zoneHash: bytes32,
  salt: uint,
  conduitKey: bytes32,
  totalOriginalConsiderationItems: uint,
});
const order = z.object({ parameters, signature: bytes });
const basic = z.object({
  considerationToken: address,
  considerationIdentifier: uint,
  considerationAmount: uint,
  offerer: address,
  zone: address,
  offerToken: address,
  offerIdentifier: uint,
  offerAmount: uint,
  basicOrderType: z.number().int(),
  startTime: uint,
  endTime: uint,
  zoneHash: bytes32,
  salt: uint,
  offererConduitKey: bytes32,
  fulfillerConduitKey: bytes32,
  totalOriginalAdditionalRecipients: uint,
  additionalRecipients: z.array(z.object({ amount: uint, recipient: address })).max(9),
  signature: bytes,
});
export const openSeaFulfillmentAbi = parseAbi([
  "struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }",
  "struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }",
  "struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }",
  "struct Order { OrderParameters parameters; bytes signature; }",
  "struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }",
  "struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }",
  "struct AdditionalRecipient { uint256 amount; address recipient; }",
  "struct BasicOrderParameters { address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address offerer; address zone; address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients; AdditionalRecipient[] additionalRecipients; bytes signature; }",
  "function fulfillBasicOrder(BasicOrderParameters parameters) payable returns(bool fulfilled)",
  "function fulfillBasicOrder_efficient_6GL6yc(BasicOrderParameters parameters) payable returns(bool fulfilled)",
  "function fulfillOrder(Order order,bytes32 fulfillerConduitKey) payable returns(bool fulfilled)",
  "function fulfillAdvancedOrder(AdvancedOrder advancedOrder,CriteriaResolver[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns(bool fulfilled)",
]);
type Expected = { offer: MarketplaceOffer; tokenId: string; buyer: Address };
type Transaction = { to: Address; data: Hex; value: bigint };

// OpenSea's canonical conduit is allowed only within the native-ETH-only routes below.
function supportedBuyerConduit(key: Hex): boolean {
  return key === zeroHash || key.toLowerCase() === OPENSEA_CONDUIT_KEY;
}

function verifyParameters(p: z.infer<typeof parameters>, counter: bigint, expected: Expected) {
  const { offer, tokenId, buyer } = expected;
  const nft = p.offer[0];
  if (
    offer.source !== "opensea" ||
    !isAddressEqual(offer.protocolAddress, SEAPORT_ADDRESS) ||
    !isAddressEqual(p.offerer, offer.seller) ||
    isAddressEqual(buyer, p.offerer) ||
    ![0, 1, 2, 3].includes(p.orderType) ||
    nft.itemType !== 2 ||
    !isAddressEqual(nft.token, DAO_ADDRESSES.token) ||
    nft.identifierOrCriteria !== BigInt(tokenId) ||
    nft.startAmount !== 1n ||
    nft.endAmount !== 1n ||
    p.totalOriginalConsiderationItems !== BigInt(p.consideration.length) ||
    p.endTime <= p.startTime
  )
    throw new Error("Unsupported OpenSea order");
  let total = 0n;
  for (const c of p.consideration) {
    if (
      c.itemType !== 0 ||
      !isAddressEqual(c.token, zeroAddress) ||
      c.identifierOrCriteria !== 0n ||
      c.startAmount <= 0n ||
      c.startAmount !== c.endAmount ||
      isAddressEqual(c.recipient, zeroAddress)
    )
      throw new Error("Only fixed native ETH consideration is supported");
    total += c.startAmount;
  }
  if (total >= 2n ** 256n || total !== BigInt(offer.priceWei))
    throw new Error("OpenSea price changed");
  const hash = hashStruct({
    data: { ...p, counter },
    primaryType: "OrderComponents",
    types: orderTypes,
  });
  if (hash.toLowerCase() !== offer.orderHash.toLowerCase())
    throw new Error("OpenSea order hash mismatch");
}

function basicParameters(p: z.infer<typeof basic>): z.infer<typeof parameters> {
  if (
    ![0, 1, 2, 3].includes(p.basicOrderType) ||
    !supportedBuyerConduit(p.fulfillerConduitKey) ||
    p.totalOriginalAdditionalRecipients !== BigInt(p.additionalRecipients.length)
  )
    throw new Error("Unsupported basic order route");
  const consideration = (amount: bigint, recipient: Address) => ({
    itemType: 0,
    token: p.considerationToken,
    identifierOrCriteria: p.considerationIdentifier,
    startAmount: amount,
    endAmount: amount,
    recipient,
  });
  return {
    offerer: p.offerer,
    zone: p.zone,
    offer: [
      {
        itemType: 2,
        token: p.offerToken,
        identifierOrCriteria: p.offerIdentifier,
        startAmount: p.offerAmount,
        endAmount: p.offerAmount,
      },
    ],
    consideration: [
      consideration(p.considerationAmount, p.offerer),
      ...p.additionalRecipients.map((c) => consideration(c.amount, c.recipient)),
    ],
    orderType: p.basicOrderType,
    startTime: p.startTime,
    endTime: p.endTime,
    zoneHash: p.zoneHash,
    salt: p.salt,
    conduitKey: p.offererConduitKey,
    totalOriginalConsiderationItems: p.totalOriginalAdditionalRecipients + 1n,
  };
}

/** Decode the exact transaction again in the wallet client; never execute opaque provider calldata. */
export function verifyOpenSeaTransaction(
  tx: Transaction,
  expected: Expected & { counter: bigint },
): void {
  if (!isAddressEqual(tx.to, SEAPORT_ADDRESS) || tx.value !== BigInt(expected.offer.priceWei))
    throw new Error("Unexpected OpenSea transaction destination or value");
  const decoded = decodeFunctionData({ abi: openSeaFulfillmentAbi, data: tx.data });
  let p: z.infer<typeof parameters>;
  if (
    decoded.functionName === "fulfillBasicOrder" ||
    decoded.functionName === "fulfillBasicOrder_efficient_6GL6yc"
  ) {
    p = basicParameters(basic.parse(decoded.args[0]));
  } else if (decoded.functionName === "fulfillOrder") {
    const [o, conduit] = decoded.args;
    if (!supportedBuyerConduit(conduit)) throw new Error("Unexpected buyer conduit");
    p = parameters.parse(o.parameters);
  } else {
    const [o, criteria, conduit, recipient] = decoded.args;
    if (
      o.numerator !== 1n ||
      o.denominator !== 1n ||
      criteria.length ||
      !supportedBuyerConduit(conduit) ||
      !isAddressEqual(recipient, expected.buyer)
    )
      throw new Error("Unsupported advanced order route");
    p = parameters.parse(o.parameters);
  }
  verifyParameters(p, expected.counter, expected);
}

export function encodeOpenSeaFulfillment(raw: unknown, expected: Expected): Transaction {
  const response = z
    .object({
      protocol: z.enum(["seaport", "seaport1.6"]),
      fulfillment_data: z.object({
        orders: z
          .array(z.object({ parameters: parameters.extend({ counter: uint }), signature: bytes }))
          .length(1),
        transaction: z.object({
          chain: z.literal(8453),
          to: address,
          value: uint,
          function: z.string().max(2048),
          input_data: z.unknown(),
        }),
      }),
    })
    .parse(raw);
  const { orders, transaction } = response.fulfillment_data;
  verifyParameters(orders[0].parameters, orders[0].parameters.counter, expected);
  const name = transaction.function.split("(")[0];
  let data: Hex;
  if (name === "fulfillBasicOrder" || name === "fulfillBasicOrder_efficient_6GL6yc") {
    const input = z.object({ parameters: basic }).parse(transaction.input_data);
    data = encodeFunctionData({
      abi: openSeaFulfillmentAbi,
      functionName: name,
      args: [input.parameters],
    });
  } else if (name === "fulfillOrder") {
    const input = z.object({ order, fulfillerConduitKey: bytes32 }).parse(transaction.input_data);
    data = encodeFunctionData({
      abi: openSeaFulfillmentAbi,
      functionName: name,
      args: [input.order, input.fulfillerConduitKey],
    });
  } else if (name === "fulfillAdvancedOrder") {
    const input = z
      .object({
        advancedOrder: order.extend({
          numerator: z.literal(1).or(z.literal("1")).or(z.literal(1n)),
          denominator: z.literal(1).or(z.literal("1")).or(z.literal(1n)),
          extraData: bytes,
        }),
        criteriaResolvers: z.array(z.unknown()).length(0),
        fulfillerConduitKey: bytes32,
        recipient: abiAddress,
      })
      .parse(transaction.input_data);
    data = encodeFunctionData({
      abi: openSeaFulfillmentAbi,
      functionName: name,
      args: [
        { ...input.advancedOrder, numerator: 1n, denominator: 1n },
        [],
        input.fulfillerConduitKey,
        input.recipient,
      ],
    });
  } else throw new Error("Unsupported OpenSea fulfillment function");
  const tx = { to: transaction.to, data, value: transaction.value };
  verifyOpenSeaTransaction(tx, { ...expected, counter: orders[0].parameters.counter });
  return tx;
}
