import { isAddressEqual, type Address, type PublicClient } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { parseMarketplacePrice } from "@/lib/marketplace-display";
import type { MarketplaceOffer } from "@/types/marketplace";
import { communityListingCommentSchema } from "./community-comment";
import { getMarketplaceProtocolAddress } from "./routing";
import { seaportAbi } from "./seaport";

export function listingEditKey(account: string, collection: string, tokenId: string) {
  return `gnars:listing-edit:8453:${account.toLowerCase()}:${collection.toLowerCase()}:${tokenId}`;
}

export const LISTING_EDIT_EVENT = "gnars:listing-edit-changed";
export function notifyListingEditChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LISTING_EDIT_EVENT));
}

type EditJournal = {
  id: string;
  account: string;
  kind: string;
  phase: string;
  tokenId: string;
  collectionAddress?: Address;
  input?: {
    replacesOrderHash?: string;
    tokenId: string;
    source?: MarketplaceOffer["source"];
    collectionAddress?: Address;
  };
};

function completionKey(account: string, source: string, orderHash: string) {
  return `gnars:listing-edit-completed:8453:${account.toLowerCase()}:${source}:${orderHash.toLowerCase()}`;
}

export function completedListingEdit(
  account: string,
  offer: Pick<MarketplaceOffer, "source" | "orderHash" | "collectionAddress">,
  tokenId: string,
) {
  const raw = localStorage.getItem(completionKey(account, offer.source, offer.orderHash));
  if (!raw) return false;
  const marker = JSON.parse(raw) as {
    account: string;
    collection: string;
    tokenId: string;
    journalId: string;
  };
  if (
    marker.account !== account.toLowerCase() ||
    marker.collection !== (offer.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase() ||
    marker.tokenId !== tokenId ||
    !marker.journalId
  )
    throw new Error("Completed listing edit identity mismatch");
  return true;
}

export function matchesCompletedListingEdit(
  journal: EditJournal | null | undefined,
  account: string,
  offer: Pick<MarketplaceOffer, "source" | "orderHash" | "collectionAddress">,
  tokenId: string,
) {
  return (
    !!journal &&
    journal.kind === "list" &&
    journal.phase === "complete" &&
    journal.account.toLowerCase() === account.toLowerCase() &&
    journal.tokenId === tokenId &&
    journal.input?.tokenId === tokenId &&
    journal.input.source === offer.source &&
    journal.input.replacesOrderHash?.toLowerCase() === offer.orderHash.toLowerCase() &&
    (journal.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase() ===
      (offer.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase() &&
    (journal.input.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase() ===
      (offer.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase()
  );
}

/** Persist completion before removing the draft so resetting the action journal cannot replay it. */
export function finalizeListingEdit(journal: EditJournal | null | undefined) {
  if (
    !journal ||
    journal.kind !== "list" ||
    journal.phase !== "complete" ||
    !journal.input?.replacesOrderHash
  )
    return;
  const source = journal.input.source;
  if (
    !source ||
    journal.input.tokenId !== journal.tokenId ||
    (journal.input.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase() !==
      (journal.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase()
  )
    throw new Error("Completed listing edit identity mismatch");
  const collection = journal.collectionAddress ?? DAO_ADDRESSES.token;
  const markerKey = completionKey(journal.account, source, journal.input.replacesOrderHash);
  const marker = JSON.stringify({
    account: journal.account.toLowerCase(),
    collection: collection.toLowerCase(),
    tokenId: journal.tokenId,
    journalId: journal.id,
  });
  let changed = false;
  if (localStorage.getItem(markerKey) !== marker) {
    localStorage.setItem(markerKey, marker);
    changed = true;
  }
  const key = listingEditKey(journal.account, collection, journal.tokenId);
  const raw = localStorage.getItem(key);
  if (raw) {
    const parsed = listingEditDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("Unable to verify saved listing edit draft");
    if (
      matchesCompletedListingEdit(
        journal,
        journal.account,
        parsed.data.offer as MarketplaceOffer,
        parsed.data.tokenId,
      )
    ) {
      localStorage.removeItem(key);
      changed = true;
    }
  }
  if (changed) notifyListingEditChanged();
}

const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
export const listingEditDraftSchema = z.object({
  version: z.literal(1),
  tokenId: z.string().regex(/^\d+$/),
  price: z.string().max(100),
  duration: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  comment: z.string().max(280),
  offer: z.object({
    id: z.string(),
    source: z.enum(["opensea", "gnars", "gnars-contract"]),
    orderHash: hash,
    protocolAddress: address,
    seller: address,
    collectionAddress: address.optional(),
    priceWei: z.string().regex(/^\d+$/),
    currency: z.literal("ETH"),
    expiresAt: z.number().int(),
    listingComment: communityListingCommentSchema.optional(),
    feePolicy: z.object({ basisPoints: z.number(), recipient: address }).optional(),
  }),
});
export type ListingEditDraft = z.infer<typeof listingEditDraftSchema>;

export function readListingEditDraft(
  account: string,
  collection: string,
  tokenId: string,
): ListingEditDraft | null {
  try {
    const raw = localStorage.getItem(listingEditKey(account, collection, tokenId));
    if (!raw) return null;
    const draft = listingEditDraftSchema.parse(JSON.parse(raw));
    if (
      draft.tokenId !== tokenId ||
      !isAddressEqual(draft.offer.seller as Address, account as Address) ||
      !isAddressEqual(
        (draft.offer.collectionAddress ?? DAO_ADDRESSES.token) as Address,
        collection as Address,
      )
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}

export function validateListingEditInput(price: string, comment: string) {
  if (!parseMarketplacePrice(price)) return false;
  return !comment.trim() || communityListingCommentSchema.safeParse(comment).success;
}

export async function isListingCancelled(
  client: PublicClient,
  offer: Pick<MarketplaceOffer, "source" | "protocolAddress" | "orderHash">,
) {
  const protocol = getMarketplaceProtocolAddress(offer.source);
  if (!isAddressEqual(protocol, offer.protocolAddress)) throw new Error("Listing protocol changed");
  const [, cancelled] = await client.readContract({
    address: protocol,
    abi: seaportAbi,
    functionName: "getOrderStatus",
    args: [offer.orderHash],
  });
  return cancelled;
}

export async function assertListingReplacement(
  client: PublicClient,
  owner: Address,
  offer: MarketplaceOffer,
  input: { source?: MarketplaceOffer["source"]; collectionAddress?: Address },
) {
  if (
    !isAddressEqual(owner, offer.seller) ||
    offer.source !== input.source ||
    !isAddressEqual(
      input.collectionAddress ?? DAO_ADDRESSES.token,
      offer.collectionAddress ?? DAO_ADDRESSES.token,
    )
  )
    throw new Error("Replacement does not match the seller or collection");
  if (!(await isListingCancelled(client, offer)))
    throw new Error("Confirm cancellation before replacing this listing");
}
