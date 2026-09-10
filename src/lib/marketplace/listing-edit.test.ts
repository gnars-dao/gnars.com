import type { Address, PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceOffer } from "@/types/marketplace";
import {
  assertListingReplacement,
  completedListingEdit,
  finalizeListingEdit,
  isListingCancelled,
  LISTING_EDIT_EVENT,
  listingEditKey,
  matchesCompletedListingEdit,
  notifyListingEditChanged,
  readListingEditDraft,
  validateListingEditInput,
} from "./listing-edit";
import { SEAPORT_ADDRESS } from "./seaport";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const offer: MarketplaceOffer = {
  id: "test",
  seller: owner,
  source: "gnars",
  protocolAddress: SEAPORT_ADDRESS,
  orderHash: `0x${"1".repeat(64)}`,
  priceWei: "10000000000000000",
  expiresAt: 2000000000,
  currency: "ETH",
};
const draft = {
  version: 1,
  tokenId: "12",
  offer,
  price: "0.02",
  duration: 7,
  comment: "New story",
};
afterEach(() => vi.unstubAllGlobals());

describe("listing edit safety", () => {
  it.each([false, true])(
    "requires the exact order to be cancelled, including after a timeout: %s",
    async (cancelled) => {
      const readContract = vi.fn().mockResolvedValue([false, cancelled, 0n, 0n]);
      const client = { readContract } as unknown as PublicClient;
      const result = assertListingReplacement(client, owner, offer, { source: "gnars" });
      if (cancelled) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("Confirm cancellation");
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: SEAPORT_ADDRESS,
          functionName: "getOrderStatus",
          args: [offer.orderHash],
        }),
      );
    },
  );
  it("does not treat a fulfilled order as cancelled", async () => {
    const client = {
      readContract: vi.fn().mockResolvedValue([true, false, 1n, 1n]),
    } as unknown as PublicClient;
    await expect(
      assertListingReplacement(client, owner, offer, { source: "gnars" }),
    ).rejects.toThrow("Confirm cancellation");
  });
  it("rejects another seller, source, collection, or protocol before an RPC call", async () => {
    const readContract = vi.fn();
    const client = { readContract } as unknown as PublicClient;
    await expect(
      assertListingReplacement(client, other, offer, { source: "gnars" }),
    ).rejects.toThrow();
    await expect(
      assertListingReplacement(client, owner, offer, { source: "opensea" }),
    ).rejects.toThrow();
    await expect(
      assertListingReplacement(client, owner, offer, { source: "gnars", collectionAddress: other }),
    ).rejects.toThrow();
    await expect(isListingCancelled(client, { ...offer, protocolAddress: other })).rejects.toThrow(
      "protocol changed",
    );
    expect(readContract).not.toHaveBeenCalled();
  });
  it("propagates failed reads instead of declaring cancellation", async () => {
    const client = {
      readContract: vi.fn().mockRejectedValue(new Error("RPC unavailable")),
    } as unknown as PublicClient;
    await expect(isListingCancelled(client, offer)).rejects.toThrow("RPC unavailable");
  });
  it("restores a matching draft but not another account, NFT, or collection", () => {
    const getItem = vi.fn().mockReturnValue(JSON.stringify(draft));
    vi.stubGlobal("localStorage", { getItem });
    expect(readListingEditDraft(owner, DAO_ADDRESSES.token, "12")).toEqual(draft);
    expect(readListingEditDraft(other, DAO_ADDRESSES.token, "12")).toBeNull();
    expect(readListingEditDraft(owner, DAO_ADDRESSES.token, "13")).toBeNull();
    expect(readListingEditDraft(owner, other, "12")).toBeNull();
    expect(getItem).toHaveBeenCalledWith(listingEditKey(owner, DAO_ADDRESSES.token, "12"));
  });
  it("ignores malformed or unavailable browser storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => "bad json" });
    expect(readListingEditDraft(owner, DAO_ADDRESSES.token, "12")).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readListingEditDraft(owner, DAO_ADDRESSES.token, "12")).toBeNull();
  });
  it("validates price and comment without changing fees", () => {
    expect(validateListingEditInput("0.02", "")).toBe(true);
    expect(validateListingEditInput("0", "New story")).toBe(false);
    expect(validateListingEditInput("-1", "New story")).toBe(false);
    expect(validateListingEditInput("0.02", "x".repeat(281))).toBe(false);
    expect(validateListingEditInput("0.02", "bad\x00text")).toBe(false);
  });
});

describe("listing replacement completion lifecycle", () => {
  function setup() {
    const data = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => data.set(key, value)),
      removeItem: vi.fn((key: string) => data.delete(key)),
    };
    const events = new EventTarget();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", events);
    const journal = {
      id: "replacement-1",
      account: owner,
      kind: "list",
      phase: "complete",
      tokenId: "12",
      input: { source: "gnars" as const, replacesOrderHash: offer.orderHash, tokenId: "12" },
    };
    data.set(listingEditKey(owner, DAO_ADDRESSES.token, "12"), JSON.stringify(draft));
    return { data, storage, events, journal };
  }
  it("matches exact replacement identity, not merely the same NFT", () => {
    const { journal } = setup();
    expect(matchesCompletedListingEdit(journal, owner, offer, "12")).toBe(true);
    for (const changed of [
      { ...journal, account: other },
      { ...journal, kind: "cancel" },
      { ...journal, phase: "saving" },
      { ...journal, tokenId: "13" },
      { ...journal, collectionAddress: other as Address },
      { ...journal, input: { ...journal.input, replacesOrderHash: `0x${"2".repeat(64)}` } },
      { ...journal, input: { ...journal.input, replacesOrderHash: undefined } },
      { ...journal, input: { ...journal.input, source: "opensea" as const } },
      { ...journal, input: { ...journal.input, collectionAddress: other as Address } },
    ])
      expect(matchesCompletedListingEdit(changed, owner, offer, "12")).toBe(false);
  });
  it("persists completion before deleting the matching draft and survives journal reset", () => {
    const { data, storage, journal } = setup();
    finalizeListingEdit(journal);
    expect(completedListingEdit(owner, offer, "12")).toBe(true);
    expect(data.has(listingEditKey(owner, DAO_ADDRESSES.token, "12"))).toBe(false);
    expect(storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      storage.removeItem.mock.invocationCallOrder[0],
    );
    expect(completedListingEdit(other, offer, "12")).toBe(false);
    expect(completedListingEdit(owner, { ...offer, source: "opensea" }, "12")).toBe(false);
  });
  it("does not erase a newer draft for another order on the same NFT", () => {
    const { data, journal } = setup();
    const key = listingEditKey(owner, DAO_ADDRESSES.token, "12");
    data.set(
      key,
      JSON.stringify({ ...draft, offer: { ...offer, orderHash: `0x${"2".repeat(64)}` } }),
    );
    finalizeListingEdit(journal);
    expect(data.has(key)).toBe(true);
    expect(completedListingEdit(owner, offer, "12")).toBe(true);
  });
  it("never clears a draft if durable completion storage fails", () => {
    const { storage, journal } = setup();
    storage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => finalizeListingEdit(journal)).toThrow("quota exceeded");
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(journal.phase).toBe("complete");
  });
  it("retains the durable marker and completion when draft deletion fails", () => {
    const { storage, journal } = setup();
    storage.removeItem.mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(() => finalizeListingEdit(journal)).toThrow("storage blocked");
    expect(completedListingEdit(owner, offer, "12")).toBe(true);
    expect(journal.phase).toBe("complete");
  });
  it("cleans up once and notifies same-tab recovery subscribers", () => {
    const { events, journal, storage } = setup();
    const listener = vi.fn();
    events.addEventListener(LISTING_EDIT_EVENT, listener);
    finalizeListingEdit(journal);
    finalizeListingEdit(journal);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    notifyListingEditChanged();
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("does not finalize an unresolved or ordinary listing", () => {
    const { journal, storage } = setup();
    finalizeListingEdit({ ...journal, phase: "saving" });
    finalizeListingEdit({ ...journal, input: { ...journal.input, replacesOrderHash: undefined } });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("fails closed when the completion marker is malformed or its NFT identity changed", () => {
    const { storage, journal } = setup();
    finalizeListingEdit(journal);
    expect(() => completedListingEdit(owner, offer, "13")).toThrow("identity mismatch");
    storage.getItem.mockReturnValue("bad json");
    expect(() => completedListingEdit(owner, offer, "12")).toThrow();
  });
});
