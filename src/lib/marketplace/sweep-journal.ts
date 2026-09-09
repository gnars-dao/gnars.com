import { isAddressEqual, type Address } from "viem";
import { getMarketplaceProtocolAddress } from "./routing";
import {
  getListingOrderHash,
  getListingPriceWei,
  validateListingStructure,
  type MarketplaceTransactionIntent,
} from "./seaport";
import { getSweepFulfillment, getSweepResults, MAX_SWEEP_ITEMS, type SweepQuote } from "./sweep";

export type SweepSnapshot = Pick<SweepQuote, "listings" | "protocolAddress"> & {
  result?: ReturnType<typeof getSweepResults>;
};

export function validateSweepSnapshot(raw: SweepSnapshot, buyer: Address): SweepSnapshot {
  if (
    !raw ||
    !Array.isArray(raw.listings) ||
    raw.listings.length < 1 ||
    raw.listings.length > MAX_SWEEP_ITEMS ||
    typeof raw.protocolAddress !== "string" ||
    !isAddressEqual(raw.protocolAddress, getMarketplaceProtocolAddress("gnars-contract"))
  )
    throw new Error("Saved sweep protocol or items changed");
  const listings = raw.listings.map((listing) =>
    validateListingStructure(listing, { source: "gnars-contract", allowExpired: true }),
  );
  if (listings.some((listing) => isAddressEqual(listing.parameters.offerer, buyer)))
    throw new Error("The seller cannot buy their own listing");
  getSweepFulfillment(listings, { allowExpired: true });
  return { ...raw, listings };
}

export function validateSweepQuote(
  raw: SweepQuote,
  buyer: Address,
  now = Math.floor(Date.now() / 1000),
): SweepQuote {
  const snapshot = validateSweepSnapshot(raw, buyer);
  const call = getSweepFulfillment(snapshot.listings);
  if (
    !Number.isSafeInteger(raw.expiresAt) ||
    raw.expiresAt <= now ||
    raw.totalWei !== call.value.toString() ||
    !Array.isArray(raw.items) ||
    raw.items.length !== snapshot.listings.length
  )
    throw new Error("Sweep quote expired or changed; review the selection again");
  for (const [index, listing] of snapshot.listings.entries()) {
    const item = raw.items[index];
    const offer = item?.offers?.[0];
    if (
      item?.tokenId !== listing.parameters.offer[0].identifierOrCriteria ||
      item.collectionAddress !== undefined ||
      item.offers.length !== 1 ||
      !offer ||
      offer.source !== "gnars-contract" ||
      offer.orderHash.toLowerCase() !== getListingOrderHash(listing.parameters).toLowerCase() ||
      !isAddressEqual(offer.protocolAddress, snapshot.protocolAddress) ||
      offer.priceWei !== getListingPriceWei(listing).toString()
    )
      throw new Error("Sweep preview does not match its signed orders");
  }
  return { ...raw, listings: snapshot.listings };
}

export function verifySweepIntent(
  snapshot: SweepSnapshot,
  intent: MarketplaceTransactionIntent,
): void {
  const call = getSweepFulfillment(snapshot.listings, { allowExpired: true });
  if (
    !isAddressEqual(intent.to, call.to) ||
    intent.data.toLowerCase() !== call.data.toLowerCase() ||
    intent.value !== call.value.toString()
  )
    throw new Error("Saved sweep transaction does not match its signed orders");
}
