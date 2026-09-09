import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import type { MarketplaceItem } from "@/types/marketplace";
import { getMarketplaceProtocolAddress } from "./routing";
import {
  getListingOrderHash,
  getListingPriceWei,
  orderValues,
  validateListingStructure,
  type SignedListing,
} from "./seaport";

export const MAX_SWEEP_ITEMS = 10;
export type SweepSelection = { orderHash: Hex; tokenId: string; priceWei: string };
export type SweepQuote = {
  listings: SignedListing[];
  items: MarketplaceItem[];
  totalWei: string;
  expiresAt: number;
  protocolAddress: Address;
};

// Pinned Seaport 1.6 ConsiderationInterface and ConsiderationEventsAndErrors.
export const sweepAbi = parseAbi([
  "struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }",
  "struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }",
  "struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }",
  "struct Order { OrderParameters parameters; bytes signature; }",
  "struct FulfillmentComponent { uint256 orderIndex; uint256 itemIndex; }",
  "struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }",
  "struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }",
  "struct Execution { ReceivedItem item; address offerer; bytes32 conduitKey; }",
  "function fulfillAvailableOrders(Order[] orders,FulfillmentComponent[][] offerFulfillments,FulfillmentComponent[][] considerationFulfillments,bytes32 fulfillerConduitKey,uint256 maximumFulfilled) payable returns(bool[] availableOrders,Execution[] executions)",
  "event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,SpentItem[] offer,ReceivedItem[] consideration)",
]);

export function getSweepFulfillment(
  listings: readonly SignedListing[],
  options: { allowExpired?: boolean } = {},
) {
  if (!listings.length || listings.length > MAX_SWEEP_ITEMS) throw new Error("Invalid sweep size");
  const tokens = new Set<string>();
  let value = 0n;
  const orders = listings.map((raw) => {
    const listing = validateListingStructure(raw, { source: "gnars-contract", ...options });
    const token = listing.parameters.offer[0].identifierOrCriteria;
    if (tokens.has(token)) throw new Error("Duplicate sweep NFT");
    tokens.add(token);
    value += getListingPriceWei(listing);
    const parameters = orderValues(listing.parameters);
    return {
      parameters: {
        ...parameters,
        totalOriginalConsiderationItems: BigInt(parameters.consideration.length),
      },
      signature: listing.signature,
    };
  });
  if (value >= 2n ** 256n) throw new Error("Sweep value overflow");
  // Singleton groups preserve each signed payment recipient without aggregation ambiguity.
  const offerFulfillments = orders.map((_, index) => [
    { orderIndex: BigInt(index), itemIndex: 0n },
  ]);
  const considerationFulfillments = orders.flatMap((order, index) =>
    order.parameters.consideration.map((_, item) => [
      { orderIndex: BigInt(index), itemIndex: BigInt(item) },
    ]),
  );
  return {
    to: getMarketplaceProtocolAddress("gnars-contract"),
    data: encodeFunctionData({
      abi: sweepAbi,
      functionName: "fulfillAvailableOrders",
      args: [orders, offerFulfillments, considerationFulfillments, zeroHash, BigInt(orders.length)],
    }),
    value,
  };
}

export function getSweepResults(
  listings: readonly SignedListing[],
  buyer: Address,
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
) {
  const { to } = getSweepFulfillment(listings, { allowExpired: true });
  const expected = new Map(
    listings.map((listing) => [getListingOrderHash(listing.parameters).toLowerCase(), listing]),
  );
  const purchased = new Set<string>();
  let spent = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, to)) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: sweepAbi,
        eventName: "OrderFulfilled",
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      continue;
    }
    const listing = expected.get(event.args.orderHash.toLowerCase());
    if (!listing) continue;
    const p = listing.parameters;
    const nft = p.offer[0];
    if (
      purchased.has(nft.identifierOrCriteria) ||
      !isAddressEqual(event.args.offerer, p.offerer) ||
      !isAddressEqual(event.args.zone, p.zone) ||
      !isAddressEqual(event.args.recipient, buyer) ||
      event.args.offer.length !== 1 ||
      event.args.consideration.length !== p.consideration.length
    )
      throw new Error("Sweep receipt does not match the reviewed orders");
    const offer = event.args.offer[0];
    if (
      offer.itemType !== nft.itemType ||
      !isAddressEqual(offer.token, nft.token) ||
      offer.identifier !== BigInt(nft.identifierOrCriteria) ||
      offer.amount !== 1n
    )
      throw new Error("Sweep NFT transfer mismatch");
    for (const [index, payment] of event.args.consideration.entries()) {
      const signed = p.consideration[index];
      if (
        payment.itemType !== signed.itemType ||
        !isAddressEqual(payment.token, signed.token) ||
        payment.identifier !== BigInt(signed.identifierOrCriteria) ||
        payment.amount !== BigInt(signed.startAmount) ||
        !isAddressEqual(payment.recipient, signed.recipient)
      )
        throw new Error("Sweep payment mismatch");
    }
    purchased.add(nft.identifierOrCriteria);
    spent += getListingPriceWei(listing);
  }
  if (!purchased.size) throw new Error("Sweep receipt has no verified purchases");
  return {
    purchasedTokenIds: listings
      .map((listing) => listing.parameters.offer[0].identifierOrCriteria)
      .filter((id) => purchased.has(id)),
    skippedTokenIds: listings
      .map((listing) => listing.parameters.offer[0].identifierOrCriteria)
      .filter((id) => !purchased.has(id)),
    spentWei: spent.toString(),
  };
}
